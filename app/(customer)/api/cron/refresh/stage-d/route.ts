import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runStageDAndStore } from "@/lib/customer/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Stage D — HubSpot companies + deals + Fireflies note enrichment
 *
 * Pulls ~922 active customer companies from HubSpot, their associated deals,
 * and their most recent Fireflies-processed note. Haiku-enriches each note
 * for sentiment + topics + action items. Writes to pipeline_state stage='D'.
 *
 * Scheduled in vercel.json: 22:00 UTC daily (parallel to A/B/C).
 *
 * Optional — silently no-ops when HUBSPOT_ACCESS_TOKEN is unset. Compose will
 * still produce a snapshot; HubSpot fields on each ScoredCustomerV2 just stay
 * null. Manual trigger: curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/refresh/stage-d
 */
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  try {
    const result = await runStageDAndStore();
    return NextResponse.json({
      ok: true,
      stage: "D",
      durationMs: result.durationMs,
      rowCount: result.rowCount,
      errors: result.errors,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, stage: "D", error: msg }, { status: 500 });
  }
}

export const POST = GET;
