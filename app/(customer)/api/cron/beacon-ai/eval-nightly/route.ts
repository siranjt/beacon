// Phase E-17.3c — Beacon AI eval nightly cron.
//
// Runs the full eval harness against all active golden Q&A pairs.
// Compares today's pass rate to the trailing 7-day baseline and Slack-
// alerts if it drops materially (>15 percentage points).
//
// Scheduled in vercel.json at 04:30 UTC (after daily refresh settles).
//
// Manual trigger: POST/GET with Authorization: Bearer $CRON_SECRET.

import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runAllActive, getRollingPassRate } from "@/lib/ai/eval-harness";
import { postSlack } from "@/lib/customer/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Pass rate drop (in percentage points) that triggers a regression alert. */
const REGRESSION_PP_THRESHOLD = 15;

export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  const evalToken = process.env.EVAL_RUNNER_TOKEN;
  if (!evalToken) {
    return NextResponse.json(
      { ok: false, error: "EVAL_RUNNER_TOKEN env var not set" },
      { status: 503 },
    );
  }

  // Use the same Vercel URL pattern as the existing health-alert cron
  const apiBase = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  // Capture baseline BEFORE today's run (so we compare apples-to-apples)
  const baseline = await getRollingPassRate(7);

  const start = Date.now();
  const run = await runAllActive(apiBase, evalToken);
  const elapsedMs = Date.now() - start;

  const todayPassRate = run.total > 0 ? run.passed / run.total : 0;
  const baselinePassRate = baseline.passRate;
  const dropPp = (baselinePassRate - todayPassRate) * 100;

  // Slack notification
  const webhook = process.env.SLACK_WEBHOOK_URL;
  let slackPosted = false;
  if (webhook) {
    const lines: string[] = [];
    const todayPct = (todayPassRate * 100).toFixed(0);
    const baselinePct = (baselinePassRate * 100).toFixed(0);

    if (run.total === 0) {
      lines.push(`:information_source: *Beacon AI eval — no active pairs to run*`);
      lines.push("Seed the eval library via /api/admin/eval/pairs to start tracking quality.");
    } else if (dropPp >= REGRESSION_PP_THRESHOLD && baseline.total >= 5) {
      lines.push(`:rotating_light: *Beacon AI eval — REGRESSION detected*`);
      lines.push(`Today: ${todayPct}% pass (${run.passed}/${run.total})`);
      lines.push(`7d baseline: ${baselinePct}% pass (${baseline.passed}/${baseline.total})`);
      lines.push(`Drop: ${dropPp.toFixed(1)} percentage points`);
      lines.push(`*Failed pairs:*`);
      const fails = run.results.filter((r) => r.verdict === "fail" || r.verdict === "error");
      for (const f of fails.slice(0, 10)) {
        lines.push(`• ${f.verdict.toUpperCase()}: "${f.question.slice(0, 60)}" — ${f.reasoning.slice(0, 100)}`);
      }
      if (fails.length > 10) lines.push(`...and ${fails.length - 10} more`);
    } else {
      lines.push(`:white_check_mark: *Beacon AI eval — nightly run complete*`);
      lines.push(
        `${todayPct}% pass (${run.passed}/${run.total}) · partial ${run.partial} · failed ${run.failed} · errors ${run.errored}`,
      );
      lines.push(`Wall time: ${(elapsedMs / 1000).toFixed(1)}s`);
    }
    try {
      const result = await postSlack({ text: lines.join("\n") });
      slackPosted = result.sent;
    } catch (e) {
      console.warn("[eval-nightly] slack post failed:", e);
    }
  }

  return NextResponse.json({
    ok: true,
    today: {
      total: run.total,
      passed: run.passed,
      partial: run.partial,
      failed: run.failed,
      errored: run.errored,
      pass_rate: todayPassRate,
    },
    baseline_7d: baseline,
    drop_pp: Number(dropPp.toFixed(2)),
    regression_alert_threshold_pp: REGRESSION_PP_THRESHOLD,
    elapsed_ms: elapsedMs,
    slack_posted: slackPosted,
    slack_configured: !!webhook,
    results: run.results,
  });
}

export const POST = GET;
