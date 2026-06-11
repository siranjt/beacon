import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runMetabaseEnrichment } from "@/lib/brain/metabase-enrichment";
import { postSlack } from "@/lib/customer/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Bounded by ~900 active customers × ~3 fields. The bulk of the work is
// fast-path probes (no embedding call). Worst case (cold cache + every
// field changed) is still well under 300s. 1024MB is comfortable; we
// don't load the snapshot's full customer array into a hot data
// structure beyond the active customer_id Set.
export const maxDuration = 300;

/**
 * META-A4 — Weekly Metabase enrichment cron.
 *
 * GET /api/cron/keeper/enrich-from-metabase
 *   Default: pulls slow-changing BaseSheet fields, writes/refines Keeper
 *   facts, returns aggregate stats.
 *
 * GET /api/cron/keeper/enrich-from-metabase?limit_customers=N
 *   Cap how many customers get processed. Useful for ops smoke tests
 *   from the admin status page.
 *
 * Scheduled in vercel.json at Sunday 06:00 UTC (= 11:30 AM IST Sunday).
 * Late enough that Stage A has already refreshed the snapshot via the
 * daily 22:00 UTC sweep on Saturday; early enough that Monday morning's
 * AM workflow sees the latest Keeper.
 *
 * Cost: this cron makes ZERO Anthropic/OpenAI calls. Pure Metabase CSV
 * fetch + Neon Postgres writes + (optional) Voyage embeddings on changed
 * values. Steady-state run is ~$0 Anthropic spend — the embedding cost
 * is shared with the rest of the Keeper write path and bounded by
 * fast-path probes.
 *
 * Alerting: posts to Slack when the error rate exceeds 5% of attempted
 * facts. Quiet on healthy runs (the cron log in Vercel is enough).
 */
const ERROR_RATE_ALERT_THRESHOLD = 0.05;

export async function GET(req: NextRequest) {
  const auth = requireCronAuth(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit_customers");
  const limit_customers = limitParam ? Math.max(1, Number(limitParam)) : undefined;
  if (limit_customers !== undefined && !Number.isFinite(limit_customers)) {
    return NextResponse.json(
      { ok: false, error: `invalid limit_customers=${limitParam}` },
      { status: 400 },
    );
  }

  const t0 = Date.now();
  const result = await runMetabaseEnrichment({ limit_customers });
  const elapsed_ms = Date.now() - t0;

  // Compute error rate over total fact-attempts. Skipped customers and
  // unchanged facts don't count as attempts.
  const attempts =
    result.facts_written +
    result.facts_refined +
    result.facts_unchanged +
    result.facts_failed;
  const error_rate = attempts > 0 ? result.facts_failed / attempts : 0;

  let slack_posted = false;
  if (error_rate > ERROR_RATE_ALERT_THRESHOLD) {
    try {
      const lines = [
        `:warning: *Keeper enrichment error rate ${(error_rate * 100).toFixed(1)}%*`,
        `Threshold: ${(ERROR_RATE_ALERT_THRESHOLD * 100).toFixed(0)}%.`,
        `Customers: ${result.customers_processed}/${result.customers_in_basesheet} processed, ${result.customers_skipped} skipped.`,
        `Facts: ${result.facts_written} new, ${result.facts_refined} refined, ${result.facts_unchanged} unchanged, ${result.facts_failed} failed.`,
        `Sample errors: ${result.errors.slice(0, 3).join(" | ").slice(0, 800)}`,
        `Run at ${result.started_at} • ${elapsed_ms}ms`,
      ];
      const r = await postSlack({ text: lines.join("\n") });
      slack_posted = r.sent;
    } catch (e) {
      console.warn("[keeper/enrich-from-metabase] slack post failed:", e);
    }
  }

  return NextResponse.json(
    {
      ok: error_rate <= ERROR_RATE_ALERT_THRESHOLD,
      elapsed_ms,
      error_rate,
      slack_posted,
      ...result,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const POST = GET;
