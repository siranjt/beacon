import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runDailyDigestForAllAms } from "@/lib/ai/proactive-beacon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Phase E-17 Wave 3b — Proactive Beam · Daily anomaly digest.
 *
 * GET /api/cron/beacon-ai/daily-digest
 *   → for each AM in AM_EMAILS, compares today's snapshot vs yesterday's
 *     and surfaces "material" overnight changes: composite drops > 10,
 *     tier flips (worse + RED→YELLOW wins), new tickets in last 24h, and
 *     new missed payments. If there's ≥1 material change, drafts a
 *     personalized Slack DM via Haiku and posts via SLACK_BOT_TOKEN.
 *     AMs with no material change are skipped — no noise on quiet days.
 *
 *     First-run / yesterday-missing branch: posts a single courteous line
 *     ("first run — full digest tomorrow") so the AM knows the cron fired.
 *
 * Scheduled in vercel.json at 02:30 UTC daily (= 08:00 AM IST). Runs the
 * same minute as `/api/cron/digest`, which is fine — they're independent
 * crons and Vercel handles concurrency.
 *
 * Manual / dry-run invocation: pass `?dry_run=true` to compute the diff
 * + render the body without posting to Slack.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        "https://beacon-zoca.vercel.app/api/cron/beacon-ai/daily-digest?dry_run=true"
 *
 * Auth: Bearer CRON_SECRET (shared by all cron routes via requireCronAuth).
 */
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dry_run") === "true";

  try {
    const result = await runDailyDigestForAllAms({ dryRun });
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
