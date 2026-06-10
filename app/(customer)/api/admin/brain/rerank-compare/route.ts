/**
 * Voyage rerank A/B harness endpoint.
 *
 * Admin-only. Given (entity_id, query, candidatesPerStage, topK), runs the
 * Wave-1 hybrid pipeline through the RRF merge stage ONCE, then reranks
 * the same candidate set TWICE — once with `rerank-2.5-lite` (the cheap
 * model we ship today) and once with `rerank-2.5` (the full model we're
 * considering swapping to). Returns both ranked top-K lists plus a
 * Spearman agreement score between the two orderings so an admin can
 * eyeball whether the full model is actually moving the needle.
 *
 * Soft-fail philosophy: each rerank call is independent. If `rerank-2.5`
 * isn't on our Voyage plan (404 / 403 / etc), the helper returns null
 * and we surface { error } on that side while still serving the lite
 * side. Admins see the asymmetry on the page rather than a 500.
 *
 * NOT scoped per-AM. `entity_id` is optional — when omitted we search
 * the whole book (useful for cross-customer compare). When provided we
 * scope to that single customer's facts via the customer_id filter on
 * retrieveHybridStaged. We map entity_id → customer_id off the latest
 * snapshot because the Keeper key is the Chargebee customer_id, not the
 * entity UUID.
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { retrieveHybridStaged } from "@/lib/brain/retrieve";
import {
  rerankDocuments,
  factEmbeddingText,
} from "@/lib/brain/embeddings";
import { spearmanCorrelation } from "@/lib/brain/spearman";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import type { MergeEntry } from "@/lib/brain/retrieve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Models we A/B. Hardcoded — the whole point of this page is comparing
 *  these two specific Voyage offerings. */
const MODEL_LITE = "rerank-2.5-lite";
const MODEL_FULL = "rerank-2.5";

interface RankedRow {
  fact_id: string;
  customer_id: string;
  topic_subcategory: string;
  field_name: string;
  value: string;
  rrf_score: number;
  rerank_score: number;
  matched_via: Array<"embedding" | "keyword">;
}

interface SideResult {
  model: string;
  ok: boolean;
  rows: RankedRow[];
  /** Wall time for THIS rerank call only (ms). */
  rerank_ms: number;
  /** Whether Voyage actually ranked (vs soft-fail to RRF order). */
  ran: boolean;
  /** Error string when ok=false. */
  error?: string;
}

function buildRowsFromOrdering(
  candidates: MergeEntry[],
  reranked: Array<{ index: number; relevance_score: number }>,
): RankedRow[] {
  const rows: RankedRow[] = [];
  for (const r of reranked) {
    const src = candidates[r.index];
    if (!src) continue;
    rows.push({
      fact_id: src.fact.fact_id,
      customer_id: src.fact.customer_id,
      topic_subcategory: src.fact.topic_subcategory,
      field_name: src.fact.field_name,
      value: src.fact.value,
      rrf_score: src.rrf_score,
      rerank_score: r.relevance_score,
      matched_via: src.matched_via,
    });
  }
  return rows;
}

async function rerankOnce(
  query: string,
  candidates: MergeEntry[],
  topK: number,
  model: string,
): Promise<SideResult> {
  const t0 = Date.now();

  if (candidates.length === 0) {
    return {
      model,
      ok: true,
      rows: [],
      rerank_ms: 0,
      ran: false,
    };
  }

  const documents = candidates.map((c) =>
    factEmbeddingText(c.fact.topic_subcategory, c.fact.field_name, c.fact.value),
  );

  try {
    const reranked = await rerankDocuments(query, documents, {
      topK: Math.min(topK, candidates.length),
      model,
    });
    const rerank_ms = Date.now() - t0;

    if (!reranked) {
      // Voyage soft-failed. Surface the asymmetry — don't silently fall
      // back to RRF, because the whole point of this page is comparing
      // what the model did.
      return {
        model,
        ok: false,
        rows: [],
        rerank_ms,
        ran: false,
        error:
          "Voyage returned no rerank result (likely missing key, 4xx, or model unavailable on this plan)",
      };
    }
    return {
      model,
      ok: true,
      rows: buildRowsFromOrdering(candidates, reranked),
      rerank_ms,
      ran: true,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      model,
      ok: false,
      rows: [],
      rerank_ms: Date.now() - t0,
      ran: false,
      error: msg,
    };
  }
}

/**
 * Resolve entity_id → customer_id off the live snapshot. We do this so
 * the harness UI can take the more human-recognizable entity_id while
 * the Keeper filter still keys on customer_id (which is what the schema
 * uses).
 */
async function resolveCustomerId(
  entity_id: string,
): Promise<{ customer_id: string | null; bizname: string | null }> {
  try {
    const snap = await readLatestSnapshotV2();
    const all = snap?.customers ?? [];
    const hit = all.find((c) => c.entity_id === entity_id);
    if (!hit) return { customer_id: null, bizname: null };
    return {
      customer_id: hit.customer_id ?? null,
      bizname: hit.company ?? null,
    };
  } catch {
    return { customer_id: null, bizname: null };
  }
}

export async function POST(req: NextRequest) {
  const user = await getApiUser();
  // Admin-only — this surface exposes raw fact internals, model errors,
  // and per-model rerank scores. Tighter than the manager-tier search.
  const denied = requireRole(user, "admin");
  if (denied) return denied;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body must be valid JSON" },
      { status: 400 },
    );
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json(
      { ok: false, error: "query is required" },
      { status: 400 },
    );
  }

  const entity_id =
    typeof body.entity_id === "string" && body.entity_id.trim()
      ? body.entity_id.trim()
      : undefined;

  const candidatesPerStage =
    typeof body.candidatesPerStage === "number" &&
    Number.isFinite(body.candidatesPerStage)
      ? Math.max(5, Math.min(200, Math.floor(body.candidatesPerStage)))
      : 50;

  const topK =
    typeof body.topK === "number" && Number.isFinite(body.topK)
      ? Math.max(1, Math.min(50, Math.floor(body.topK)))
      : 10;

  // Resolve entity_id → customer_id if provided. We tell the user when the
  // entity_id didn't resolve so they can fix the input rather than getting
  // empty results.
  let customer_id: string | undefined;
  let bizname: string | null = null;
  let entity_resolution_warning: string | null = null;
  if (entity_id) {
    const resolved = await resolveCustomerId(entity_id);
    if (!resolved.customer_id) {
      entity_resolution_warning = `entity_id "${entity_id}" did not resolve to a customer_id in the latest snapshot — searching the whole book`;
    } else {
      customer_id = resolved.customer_id;
      bizname = resolved.bizname;
    }
  }

  // Stages 1 + 2 — ONE pass for both rerank sides.
  const staged = await retrieveHybridStaged(query, {
    customer_id,
    candidatesPerStage,
  });

  // Run both rerank sides in parallel.
  const [lite, full] = await Promise.all([
    rerankOnce(query, staged.candidates, topK, MODEL_LITE),
    rerankOnce(query, staged.candidates, topK, MODEL_FULL),
  ]);

  // Spearman on the intersection of the two orderings.
  const orderingLite = lite.rows.map((r) => r.fact_id);
  const orderingFull = full.rows.map((r) => r.fact_id);
  const spearman = spearmanCorrelation(orderingLite, orderingFull);

  return NextResponse.json(
    {
      ok: true,
      query,
      entity_id: entity_id ?? null,
      customer_id: customer_id ?? null,
      bizname,
      entity_resolution_warning,
      candidatesPerStage,
      topK,
      candidate_count: staged.candidates.length,
      staged_timing: staged.timing,
      staged_ran: staged.ran,
      lite,
      full,
      spearman,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
