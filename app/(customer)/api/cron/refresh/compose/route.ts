import { NextRequest, NextResponse } from "next/server";
import { getLocationRecordIdMap } from "@/lib/customer/hubspot-locations";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { composeSnapshot } from "@/lib/customer/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Compose — reads stages A, B, C for today's snapshot_date from
 * pipeline_state, scores active entities, writes final snapshot to
 * dashboard_snapshots.
 *
 * Lightweight: ~5-15s (no fetching, just Postgres reads + score loop + write).
 *
 * Scheduled in vercel.json: '5 22 * * *' (5 min after stages start).
 * Manual trigger: curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/refresh/compose
 *
 * Fails loudly if any stage's pipeline_state row is missing for today.
 * Caller should hit the missing stage's endpoint, then retry compose.
 */
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  try {
    const snap = await composeSnapshot();
    return NextResponse.json({
      ok: true,
      stage: "compose",
      generatedAt: snap.generatedAt,
      totalActive: snap.totalActive,
      tierCounts: snap.tierCounts,
      stoplightCounts: snap.stoplightCounts,
      durationMs: snap.health.refreshDurationMs,
      errors: snap.errors || [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, stage: "compose", error: msg }, { status: 500 });
  }
}

export const POST = GET;
