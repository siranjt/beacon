import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { getSql } from "@/lib/customer/postgres";
import {
  embedTextsBatch,
  factEmbeddingText,
  formatVectorLiteral,
} from "@/lib/brain/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * One-shot backfill: compute embeddings for all beacon_brain_facts rows
 * where embedding IS NULL. Batches 128 facts per Voyage call. Run via:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://beacon-zoca.vercel.app/api/cron/brain/backfill-embeddings?limit=500"
 *
 * Query params:
 *   - limit (default 500, max 2000)
 *   - dry_run (=1 to count rows but not write)
 *
 * Idempotent: re-running is safe; only touches rows with NULL embedding.
 *
 * Cost reference (voyage-3-lite, ~$0.02/M tokens):
 *   1,269 facts × ~30 tokens each = ~38k tokens = ~$0.00076 per backfill.
 *   Negligible. Don't worry about chunking for cost.
 *
 * Throughput: ~10 facts/s end-to-end via batched API. 1,269 facts → ~2 min.
 */
export async function GET(req: NextRequest) {
  const auth = requireCronAuth(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const limit = Math.max(
    1,
    Math.min(2000, Number(url.searchParams.get("limit") || 500)),
  );
  const dryRun = url.searchParams.get("dry_run") === "1";

  const sql = getSql();
  if (!sql) {
    return NextResponse.json(
      { ok: false, error: "no postgres" },
      { status: 500 },
    );
  }

  const startedAt = Date.now();

  // Fetch facts missing an embedding.
  const rows = (await sql`
    SELECT fact_id, topic_subcategory, field_name, value
    FROM beacon_brain_facts
    WHERE embedding IS NULL
      AND soft_deleted_at IS NULL
    ORDER BY created_at ASC
    LIMIT ${limit}
  `) as Array<{
    fact_id: string;
    topic_subcategory: string;
    field_name: string;
    value: string;
  }>;

  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      total_remaining: 0,
      processed: 0,
      message: "Nothing to backfill. All facts have embeddings.",
    });
  }

  // Also report how many remain after this batch.
  const remainingRows = (await sql`
    SELECT COUNT(*)::int AS n
    FROM beacon_brain_facts
    WHERE embedding IS NULL
      AND soft_deleted_at IS NULL
  `) as Array<{ n: number }>;
  const totalRemaining = remainingRows[0]?.n ?? 0;

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      would_process: rows.length,
      total_remaining: totalRemaining,
      first_5: rows.slice(0, 5).map((r) => ({
        fact_id: r.fact_id,
        text: factEmbeddingText(r.topic_subcategory, r.field_name, r.value),
      })),
    });
  }

  // Embed in batches of 128 (Voyage's max input array size).
  const texts = rows.map((r) =>
    factEmbeddingText(r.topic_subcategory, r.field_name, r.value),
  );
  const vectors = await embedTextsBatch(texts);

  let updated = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const vec = vectors[i];
    if (!vec) {
      failed++;
      continue;
    }
    try {
      await sql`
        UPDATE beacon_brain_facts
        SET embedding = ${formatVectorLiteral(vec)}::vector
        WHERE fact_id = ${rows[i].fact_id}
          AND embedding IS NULL
      `;
      updated++;
    } catch (e) {
      failed++;
      errors.push(
        `${rows[i].fact_id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return NextResponse.json(
    {
      ok: true,
      processed: rows.length,
      updated,
      failed,
      remaining_after: Math.max(0, totalRemaining - updated),
      elapsed_ms: Date.now() - startedAt,
      errors: errors.slice(0, 10),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
