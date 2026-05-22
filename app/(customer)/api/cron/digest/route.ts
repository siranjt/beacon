import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runDigestForAllAms, slackConfigured } from "@/lib/customer/slack-digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/cron/digest
 *   → composes a per-AM Slack digest from the latest v2 snapshot and posts
 *     each to SLACK_WEBHOOK_URL.
 *
 * Scheduled in vercel.json at 02:30 UTC daily (= 08:00 AM IST).
 * Manual invocation: pass `?dry_run=1` to compose without posting.
 *
 * Auth: Bearer CRON_SECRET (shared by all cron routes via requireCronAuth).
 */
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";

  try {
    const results = await runDigestForAllAms({ dryRun });
    const sentCount = results.filter((r) => r.sent).length;
    const skippedCount = results.filter((r) => r.skipped).length;
    const errors = results
      .filter((r) => r.error)
      .map((r) => ({ am: r.am_name, error: r.error }));
    return NextResponse.json({
      ok: true,
      dryRun,
      slackConfigured: slackConfigured(),
      amCount: results.length,
      sentCount,
      skippedCount,
      errors,
      results,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const POST = GET;
