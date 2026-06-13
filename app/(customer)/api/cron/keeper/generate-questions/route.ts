/**
 * WAVE-B-3 — Keeper Question Bank nightly generator cron.
 *
 * POST /api/cron/keeper/generate-questions
 *   Auth: Authorization: Bearer ${CRON_SECRET} (via requireCronAuth).
 *
 * Pipeline (cheap on purpose — Wave-B aims for ~$0.30/mo total):
 *   1. Pull unresolved beacon_ai_failure_log rows from the last 30 days
 *      via listGapRows({ includeResolved: false, limit: 1000 }).
 *   2. Drop rows whose failure_log_id is ALREADY tied to a non-dismissed
 *      keeper_questions row — avoids regenerating the same prompt every
 *      night while it's still pending or after the AM has answered it
 *      (we only want a fresh question if the cluster pattern persists
 *      after the previous answer / dismissal).
 *   3. Embed each remaining row's description via Voyage `embedText`. Soft
 *      fails into a per-row skip (embedFailures counter) — Voyage outage
 *      shouldn't take down the cron.
 *   4. Greedy cosine cluster the embedded rows (threshold 0.85, min size
 *      3 — see lib/keeper/question-cluster.ts).
 *   5. For each cluster:
 *        a. Skip if a PENDING question already exists for the same
 *           cluster_signature (pendingSignatureExists).
 *        b. Ask Haiku to phrase ONE AM-readable question
 *           (generateQuestion). Null → skip (Haiku decided the cluster
 *           isn't coherent enough).
 *        c. Insert via createQuestion. ON CONFLICT (signature, pending)
 *           swallowed inside the repo — re-skip safely.
 *   6. Hard cap at 50 inserts per run as a safety net against runaway
 *      clustering.
 *
 * Cost model (steady state, ~30 unresolved gaps/day after triage)
 *   - Voyage embeddings: ~30 / day at $0.02/M tokens → ≪ $0.01/mo. The
 *     free tier (100k tokens/mo) covers it outright.
 *   - Haiku: ~5 clusters/day worth generating → 150/mo × ~$0.002 each =
 *     ~$0.30/mo. Worst case (full 50-cluster cap every day) caps spend at
 *     ~$3/mo.
 * Comfortably inside the Wave-B budget.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { listGapRows, type GapLogRow } from "@/lib/ai/gaps";
import { embedText } from "@/lib/brain/embeddings";
import {
  clusterGaps,
  type GapForClustering,
} from "@/lib/keeper/question-cluster";
import { generateQuestion } from "@/lib/keeper/question-generator";
import {
  createQuestion,
  pendingSignatureExists,
} from "@/lib/keeper/questions-repo";
import { getSql } from "@/lib/customer/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const GAP_WINDOW_DAYS = 30;
const GAP_QUERY_LIMIT = 1000;
const COSINE_THRESHOLD = 0.85;
const MAX_INSERTS_PER_RUN = 50;

interface RunResult {
  ok: boolean;
  rowsScanned: number;
  rowsAfterAlreadyUsedFilter: number;
  embedFailures: number;
  embeddedRows: number;
  clustersFound: number;
  questionsCreated: number;
  skippedDuplicates: number;
  skippedNullGen: number;
  skippedSignatureExists: number;
  capHit: boolean;
  error?: string;
}

/**
 * Resolve the set of beacon_ai_failure_log ids that are referenced by
 * keeper_questions rows in a non-dismissed state (pending OR answered).
 * The cron uses this to prevent re-clustering ids that already drove a
 * pending or answered question — only when the AM EXPLICITLY dismissed do
 * we let the same row contribute again. Empty set when DB unavailable.
 */
async function getAlreadyUsedFailureLogIds(): Promise<Set<number>> {
  const sql = getSql();
  if (!sql) return new Set();
  try {
    const rows = (await sql`
      SELECT DISTINCT unnest(source_failure_log_ids)::bigint AS id
      FROM keeper_questions
      WHERE status IN ('pending', 'answered')
    `) as Array<{ id: number | bigint }>;
    return new Set(rows.map((r) => Number(r.id)));
  } catch (e) {
    console.warn(
      "[cron/keeper/generate-questions] getAlreadyUsedFailureLogIds failed:",
      e instanceof Error ? e.message : e,
    );
    return new Set();
  }
}

/**
 * Customer scope for a cluster. We pick the most-common scope across the
 * cluster's underlying gap rows so the Haiku prompt has the right framing
 * ("customer X" vs "AM Y's book"). When the rows disagree we still emit
 * a question — Haiku is told the scope is mixed.
 */
function pickClusterScope(
  rows: GapLogRow[],
  ids: bigint[],
): { scope: string; category: string; customer_id: string | null; entity_id: string | null } {
  const idSet = new Set(ids.map((x) => Number(x)));
  const members = rows.filter((r) => idSet.has(r.id));
  if (members.length === 0) {
    return {
      scope: "the book",
      category: "data_missing",
      customer_id: null,
      entity_id: null,
    };
  }
  // Tally scopes + categories.
  const scopeCount = new Map<string, number>();
  const catCount = new Map<string, number>();
  for (const m of members) {
    scopeCount.set(m.scope, (scopeCount.get(m.scope) ?? 0) + 1);
    catCount.set(m.category, (catCount.get(m.category) ?? 0) + 1);
  }
  const topScope =
    [...scopeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "the book";
  const topCategory =
    [...catCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "data_missing";

  // Try to lift customer_id + entity_id from scope_meta when the scope is
  // customer-shaped. Falls back to nulls — keeper_questions allows nulls
  // for book-level questions.
  let customer_id: string | null = null;
  let entity_id: string | null = null;
  for (const m of members) {
    if (m.scope_meta && typeof m.scope_meta === "object") {
      const meta = m.scope_meta as Record<string, unknown>;
      if (!customer_id && typeof meta.customer_id === "string") {
        customer_id = meta.customer_id;
      }
      if (!entity_id && typeof meta.entity_id === "string") {
        entity_id = meta.entity_id;
      }
    }
    if (customer_id && entity_id) break;
  }

  return { scope: topScope, category: topCategory, customer_id, entity_id };
}

async function runGenerator(): Promise<RunResult> {
  const result: RunResult = {
    ok: true,
    rowsScanned: 0,
    rowsAfterAlreadyUsedFilter: 0,
    embedFailures: 0,
    embeddedRows: 0,
    clustersFound: 0,
    questionsCreated: 0,
    skippedDuplicates: 0,
    skippedNullGen: 0,
    skippedSignatureExists: 0,
    capHit: false,
  };

  // Step 1 — fetch recent unresolved gaps.
  const allGapRows = await listGapRows({
    includeResolved: false,
    limit: GAP_QUERY_LIMIT,
  });
  // Narrow to last GAP_WINDOW_DAYS (listGapRows orders by occurred_at DESC).
  const cutoffMs = Date.now() - GAP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const windowed = allGapRows.filter((r) => {
    const t = new Date(r.occurred_at).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });
  result.rowsScanned = windowed.length;
  if (windowed.length === 0) return result;

  // Step 2 — drop ids that are already in a non-dismissed question. This
  // prevents oscillation: a cluster that already has a pending answer
  // shouldn't keep re-firing every night, and one that's already been
  // answered satisfactorily shouldn't keep re-asking until the AM
  // explicitly dismisses it.
  const alreadyUsed = await getAlreadyUsedFailureLogIds();
  const filtered = windowed.filter((r) => !alreadyUsed.has(r.id));
  result.rowsAfterAlreadyUsedFilter = filtered.length;
  if (filtered.length === 0) return result;

  // Step 3 — embed each row's description. Soft-fail per row.
  const embedded: GapForClustering[] = [];
  for (const row of filtered) {
    if (!row.description) continue;
    const embResult = await embedText(row.description);
    if (!embResult) {
      result.embedFailures++;
      continue;
    }
    embedded.push({
      id: BigInt(row.id),
      description: row.description,
      embedding: embResult.embedding,
    });
  }
  result.embeddedRows = embedded.length;
  if (embedded.length < 3) return result;

  // Step 4 — greedy cluster.
  const clusters = clusterGaps(embedded, COSINE_THRESHOLD);
  result.clustersFound = clusters.length;
  if (clusters.length === 0) return result;

  // Step 5 — per-cluster generate + insert.
  for (const cluster of clusters) {
    if (result.questionsCreated >= MAX_INSERTS_PER_RUN) {
      result.capHit = true;
      break;
    }

    // Pre-check the partial-unique signature gate before spending the
    // Haiku token. Inside-the-repo conflict handler is the backstop.
    const exists = await pendingSignatureExists(cluster.signature);
    if (exists) {
      result.skippedSignatureExists++;
      continue;
    }

    const idSet = new Set(cluster.ids.map((x) => Number(x)));
    const memberDescriptions = filtered
      .filter((r) => idSet.has(r.id))
      .map((r) => r.description);
    if (memberDescriptions.length === 0) continue;

    const { scope, category, customer_id, entity_id } = pickClusterScope(
      filtered,
      cluster.ids,
    );

    const gen = await generateQuestion({
      descriptions: memberDescriptions,
      scope,
      category,
    });
    if (!gen) {
      result.skippedNullGen++;
      continue;
    }

    const id = await createQuestion({
      customer_id,
      entity_id,
      question_text: gen.question,
      source_failure_log_ids: cluster.ids,
      cluster_signature: cluster.signature,
      category: category as
        | "data_missing"
        | "tool_insufficient"
        | "out_of_scope"
        | "assumption_unclear",
    });
    if (id == null) {
      result.skippedDuplicates++;
      continue;
    }
    result.questionsCreated++;
  }

  return result;
}

export async function POST(req: NextRequest) {
  const auth = requireCronAuth(req);
  if (auth) return auth;

  try {
    const t0 = Date.now();
    const result = await runGenerator();
    return NextResponse.json({
      ...result,
      elapsed_ms: Date.now() - t0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/keeper/generate-questions] uncaught:", msg);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 },
    );
  }
}

// Vercel cron POSTs by default; expose GET only as a manual-trigger
// convenience that shares the same auth + logic. Keeps `curl` ergonomics
// flat for ops without a separate handler.
export async function GET(req: NextRequest) {
  return POST(req);
}
