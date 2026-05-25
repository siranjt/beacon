import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import {
  runStageAAndStore,
  runTargetedRefreshForNewCustomers,
} from "@/lib/customer/refresh";
import { todaySnapshotDate } from "@/lib/customer/pipeline-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Stage A — Chargebee subs + invoices + transactions + BaseSheet.
 * Lightweight payloads, fast (~10-20s typical).
 * Writes pipeline_state for today's date with stage='A'.
 *
 * Scheduled in vercel.json: '0 * * * *' (hourly at :00).
 * Manual trigger: curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/refresh/stage-a
 *
 * Phase E-11 (G3) — When Stage A detects entity_ids new vs. yesterday's
 * snapshot, fire targeted Stage B/C/D in waitUntil() so their signals land
 * for fresh customers without waiting for the nightly 22:00 UTC pass. The
 * Stage A response goes out promptly while B/C/D continue in the background;
 * the next Compose at :05 picks up whatever landed.
 */
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  try {
    const result = await runStageAAndStore();
    if (result.newEntityIds.length > 0) {
      const date = todaySnapshotDate();
      waitUntil(
        runTargetedRefreshForNewCustomers(date, result.newEntityIds).catch((e) => {
          // Never crash the cron response on targeted-refresh failures —
          // they're soft-best-effort. The nightly pass will catch up.
          // eslint-disable-next-line no-console
          console.error("[stage-a waitUntil] targeted refresh failed:", e instanceof Error ? e.message : String(e));
        }),
      );
    }
    return NextResponse.json({
      ok: true,
      stage: "A",
      durationMs: result.durationMs,
      rowCount: result.rowCount,
      errors: result.errors,
      newEntityIdsCount: result.newEntityIds.length,
      targetedRefreshTriggered: result.newEntityIds.length > 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, stage: "A", error: msg }, { status: 500 });
  }
}

export const POST = GET;
