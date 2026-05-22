import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { writeHealthCheck } from "@/lib/customer/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/health-alert
 *   → hits /api/health, persists the result to health_check_log, and pings
 *     SLACK_WEBHOOK_URL when any probe fails.
 *
 * Scheduled in vercel.json daily; can be manually invoked via Bearer for
 * spot checks.
 *
 * Slack message: deploy URL, ISO timestamp, per-probe ok/error/latency.
 */
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  try {
    const base =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000";
    const res = await fetch(`${base}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    let probes: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};
    let ok = res.ok;
    try {
      const json = (await res.json()) as {
        ok: boolean;
        probes: typeof probes;
      };
      probes = json.probes || {};
      ok = !!json.ok;
    } catch {
      ok = false;
    }
    const errorCount = Object.values(probes).filter((p) => !p.ok).length;
    const failingProbes = Object.entries(probes).filter(([, p]) => !p.ok);

    let alerted = false;
    const webhook = process.env.SLACK_WEBHOOK_URL;
    if (!ok && webhook) {
      try {
        const lines: string[] = [
          `:rotating_light: *Beacon — health check failed*`,
          `<${base}/api/health|Open /api/health> · ${new Date().toISOString()}`,
        ];
        for (const [name, p] of failingProbes) {
          lines.push(`• *${name}*: ${p.error || "fail"} (${p.latencyMs}ms)`);
        }
        const slackRes = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: lines.join("\n") }),
          signal: AbortSignal.timeout(5_000),
        });
        alerted = slackRes.ok;
      } catch (e) {
        console.warn("[health-alert] slack post failed:", e);
      }
    }

    await writeHealthCheck({
      ok,
      probes,
      error_count: errorCount,
      alerted,
    });

    return NextResponse.json({
      ok,
      errorCount,
      alerted,
      slackConfigured: !!webhook,
      probes,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const POST = GET;
