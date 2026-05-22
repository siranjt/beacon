import { NextResponse } from "next/server";
import { pingPostgres, listSnapshotDates } from "@/lib/customer/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProbeResult = { ok: boolean; latencyMs: number; error?: string };

async function probePostgres(): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const { ok, error } = await pingPostgres();
    return { ok, latencyMs: Date.now() - t0, error: ok ? undefined : error };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function probeChargebee(): Promise<ProbeResult> {
  const t0 = Date.now();
  const site = process.env.CHARGEBEE_SITE || "zoca";
  const key = process.env.CHARGEBEE_API_KEY;
  if (!key) {
    return { ok: false, latencyMs: 0, error: "CHARGEBEE_API_KEY not set" };
  }
  try {
    const auth = Buffer.from(`${key}:`).toString("base64");
    const res = await fetch(
      `https://${site}.chargebee.com/api/v2/customers?limit=1`,
      {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    return {
      ok: res.ok,
      latencyMs: Date.now() - t0,
      error: res.ok ? undefined : `${res.status}: ${res.statusText}`,
    };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function probeMetabase(): Promise<ProbeResult> {
  const t0 = Date.now();
  // Probe Metabase's root URL. Previously hit a /public/question/<id>.csv
  // endpoint with HEAD, which Metabase 302-redirects to its API CSV endpoint
  // that only supports GET — so the followed HEAD returned 404 even when
  // Metabase was healthy. False negatives every health check.
  //
  // Hitting the root with HEAD is cheaper (no redirect chain, no CSV body)
  // and answers the more useful question: "is Metabase reachable?". The
  // CSV endpoints are exercised at runtime by lib/customer/metabase.ts via
  // GET (which works fine and is the right method for downloading data).
  // Decoupling the probe from any specific card also means renaming or
  // archiving a Metabase question doesn't break the health route.
  try {
    const url = "https://metabase.zoca.ai/";
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
    return {
      ok: res.ok,
      latencyMs: Date.now() - t0,
      error: res.ok ? undefined : `${res.status}: ${res.statusText}`,
    };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function probeSnapshotFreshness(): Promise<{
  ok: boolean;
  latestDate?: string;
  hoursSince?: number;
  error?: string;
}> {
  try {
    const dates = await listSnapshotDates(1);
    if (!dates.length) {
      return { ok: false, error: "no snapshots in dashboard_snapshots" };
    }
    const latestDate = dates[0];
    const ms =
      Date.now() - new Date(`${latestDate}T22:00:00Z`).getTime();
    const hoursSince = Math.max(0, Math.round(ms / 3_600_000));
    return {
      ok: hoursSince <= 36,                 // 36h tolerance — Vercel hobby cron can slip
      latestDate,
      hoursSince,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  const [postgres, chargebee, metabase, snapshot] = await Promise.all([
    probePostgres(),
    probeChargebee(),
    probeMetabase(),
    probeSnapshotFreshness(),
  ]);

  const ok = postgres.ok && chargebee.ok && metabase.ok && snapshot.ok;
  const body = {
    ok,
    time: new Date().toISOString(),
    probes: { postgres, chargebee, metabase, snapshot },
    config: {
      authConfigured: !!process.env.DASHBOARD_USER && !!process.env.DASHBOARD_PASSWORD,
      cronConfigured: !!process.env.CRON_SECRET,
      chargebeeConfigured: !!process.env.CHARGEBEE_API_KEY,
      postgresConfigured: !!process.env.POSTGRES_URL,
      anthropicConfigured: !!process.env.ANTHROPIC_API_KEY,
      slackWebhookConfigured: !!process.env.SLACK_WEBHOOK_URL,
      hubspotConfigured: !!process.env.HUBSPOT_ACCESS_TOKEN,
      metabaseConfigured: !!process.env.METABASE_API_KEY,
    },
  };
  return NextResponse.json(body, {
    status: ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
