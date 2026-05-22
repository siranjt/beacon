import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { composeSnapshot } from "@/lib/customer/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Phase 2.0 — this route is now an alias for /api/cron/refresh/compose.
 *
 * Earlier versions ran the entire pipeline (fetches + score + write) in one
 * function. That exceeded Vercel Hobby's 60s timeout and OOM ceiling on
 * variable cold starts. Phase 2.0 split fetching into 3 independent cron
 * functions (stage-a, stage-b, stage-c) that write pipeline_state to
 * Postgres. This route now just runs `compose`, which reads those states.
 *
 * For automatic daily refresh, vercel.json schedules:
 *   - stage-a, stage-b, stage-c at 22:00 UTC (parallel)
 *   - this route (compose) at 22:05 UTC (5 min buffer)
 *
 * Manual trigger: hit /api/cron/refresh/{stage-a,stage-b,stage-c} first,
 * then this route. Or this route alone if stages already ran today.
 */
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  try {
    const snap = await composeSnapshot();
    return NextResponse.json({
      ok: true,
      generatedAt: snap.generatedAt,
      totalActive: snap.totalActive,
      tierCounts: snap.tierCounts,
      durationMs: snap.health.refreshDurationMs,
      errors: snap.errors || [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const POST = GET;
