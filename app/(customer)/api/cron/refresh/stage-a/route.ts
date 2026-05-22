import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runStageAAndStore } from "@/lib/customer/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Stage A — Chargebee subs + invoices + transactions + BaseSheet.
 * Lightweight payloads, fast (~10-20s typical).
 * Writes pipeline_state for today's date with stage='A'.
 *
 * Scheduled in vercel.json: '0 22 * * *' (22:00 UTC daily).
 * Manual trigger: curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/refresh/stage-a
 */
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  try {
    const result = await runStageAAndStore();
    return NextResponse.json({
      ok: true,
      stage: "A",
      ...result,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, stage: "A", error: msg }, { status: 500 });
  }
}

export const POST = GET;
