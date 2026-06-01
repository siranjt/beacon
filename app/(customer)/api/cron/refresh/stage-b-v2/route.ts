// Phase E-19 W1.8 — Stage B-v2 (V2 comms ingest).
//
// Replacement-track comms pipeline that runs in its OWN function instance
// to keep memory budgets separated from V1's 5-CSV Stage B. Reads
// activeEntityIds from Stage A, fetches the bulk-events Metabase question
// (card 4052), upserts events to comms_events, derives per-entity
// CustomerMetrics, and writes to pipeline_state stage='B2'.
//
// Designed for ~3 min wall time with ~1-2 GB memory peak. With Stage B
// (V1) running in a parallel function instance, total daily refresh cost
// roughly doubles for the dual-source window but each side stays well
// inside its own budget.
//
// Cron schedule: same as Stage B/C/D (22:00 UTC) — see vercel.json.
// Manual trigger: POST/GET with Authorization: Bearer $CRON_SECRET.

import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runStageBV2AndStore } from "@/lib/customer/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  try {
    const result = await runStageBV2AndStore();
    return NextResponse.json({
      ok: true,
      stage: "B2",
      ...result,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, stage: "B2", error: msg }, { status: 500 });
  }
}

export const POST = GET;
