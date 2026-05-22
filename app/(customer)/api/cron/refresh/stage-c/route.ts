import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runStageCAndStore } from "@/lib/customer/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Stage C — Mixpanel + 5 performance cards.
 * Medium memory load. ~15-25s typical.
 * Writes pipeline_state for today's date with stage='C'.
 *
 * Scheduled in vercel.json: '0 22 * * *'. Runs in parallel with A and B.
 */
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  try {
    const result = await runStageCAndStore();
    return NextResponse.json({
      ok: true,
      stage: "C",
      ...result,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, stage: "C", error: msg }, { status: 500 });
  }
}

export const POST = GET;
