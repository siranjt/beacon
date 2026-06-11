import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runStalePrune } from "@/lib/brain/stale-prune";
import { postSlack } from "@/lib/customer/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Single bulk UPDATE against an indexed predicate — sub-second on a
// healthy Postgres. 120s budget is comfortably above any reasonable
// runtime; we never want this cron to time out and leave staleness
// counts ambiguous.
export const maxDuration = 120;

/**
 * SMART-K2 — daily Keeper stale-prune cron.
 *
 * GET /api/cron/brain/stale-prune
 *   Default behavior: mark every fact whose updated_at is older than 6
 *   months AND citation_count = 0 as `is_stale = true`. Idempotent.
 *
 * Query params (mostly for manual ops use):
 *   - dry_run=1     — count candidates without writing
 *   - age_months=N  — override the 6-month threshold (min 1)
 *
 * Scheduled in vercel.json at 05:30 UTC daily (= 11:00 AM IST). After
 * the night's brain extract-from-notes (03:30 UTC) so today's
 * candidates aren't pruned before they're even triaged. Before the
 * morning AM workflow so they see a clean retrieval surface.
 *
 * Slack alert fires when `marked > 100` — a single nightly run pruning
 * more than 100 facts is unusual; first run after deploy could trip it
 * legitimately, but subsequent runs should be small. Alert is a sanity
 * check, not a paging condition.
 */
const SLACK_ALERT_THRESHOLD = 100;

export async function GET(req: NextRequest) {
  const auth = requireCronAuth(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const ageMonthsParam = url.searchParams.get("age_months");
  const ageMonths = ageMonthsParam ? Number(ageMonthsParam) : undefined;
  if (ageMonths !== undefined && !Number.isFinite(ageMonths)) {
    return NextResponse.json(
      { ok: false, error: `invalid age_months=${ageMonthsParam}` },
      { status: 400 },
    );
  }

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const result = await runStalePrune({ dryRun, ageMonths });
  const elapsedMs = Date.now() - t0;

  // Slack sanity-check alert. Only fires on real (non-dry) runs when the
  // marked count crosses the threshold — that's the "this might be a
  // bug, not a normal Tuesday" signal.
  let slackPosted = false;
  if (!dryRun && result.marked > SLACK_ALERT_THRESHOLD) {
    try {
      const lines = [
        `:eyes: *Keeper stale-prune marked ${result.marked} facts stale*`,
        `Threshold: ${SLACK_ALERT_THRESHOLD}. Candidates this run: ${result.candidates}.`,
        `Age cutoff: ${result.age_months_used} months. citation_count column: ${result.citation_column_present ? "yes" : "no (soft-fallback)"}`,
        `Run at ${startedAt} • ${elapsedMs}ms`,
      ];
      if (result.errors.length > 0) {
        lines.push(`Errors: ${result.errors.join("; ")}`);
      }
      const res = await postSlack({ text: lines.join("\n") });
      slackPosted = res.sent;
    } catch (e) {
      console.warn("[brain/stale-prune] slack post failed:", e);
    }
  }

  return NextResponse.json(
    {
      ok: result.errors.length === 0,
      started_at: startedAt,
      elapsed_ms: elapsedMs,
      ...result,
      slack_posted: slackPosted,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const POST = GET;
