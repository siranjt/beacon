import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runMondayBriefingForAllAms } from "@/lib/ai/proactive-beacon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Phase E-17 Wave 3b — Proactive Beam · Monday morning briefing.
 *
 * GET /api/cron/beacon-ai/monday-briefing
 *   → for each AM in AM_EMAILS, picks the top 5 customers to focus on this
 *     week (worst composite, tiebreak by days_since_out), drafts a
 *     personalized Slack DM via Haiku, and posts it via SLACK_BOT_TOKEN.
 *
 * Scheduled in vercel.json at 02:30 UTC Monday (= 08:00 AM IST Monday).
 *
 * Manual / dry-run invocation: pass `?dry_run=true` to compose the briefing
 * WITHOUT posting to Slack — the rendered body comes back in `results[].body`
 * so we can verify shape + voice without spamming the team.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        "https://beacon-zoca.vercel.app/api/cron/beacon-ai/monday-briefing?dry_run=true"
 *
 * Auth: Bearer CRON_SECRET (shared by all cron routes via requireCronAuth).
 */
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dry_run") === "true";

  try {
    const result = await runMondayBriefingForAllAms({ dryRun });
    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const POST = GET;
