// Phase E-19 W2.3+W2.4 — daily-refresh watchdog.
//
// Runs 30 min after the daily compose cron (22:35 UTC). Probes the entire
// refresh pipeline state — Stage A (hourly), Stage B/C/D (daily), and the
// composed snapshot — and re-fires whatever's stale.
//
// Why this exists: silent staleness has hit the dashboard repeatedly via
// two distinct failure modes:
//
//   (1) Compose itself fails (function timeout, exception). The most recent
//       snapshot in dashboard_snapshots is days old, and the dashboard shows
//       "Snapshot is Xd ago". The W2.3 version of this watchdog caught this.
//
//   (2) An individual stage fails — most commonly Stage D (HubSpot is
//       flaky) — but compose's graceful degradation uses yesterday's
//       fallback row and writes a "fresh-looking" snapshot. The snapshot
//       appears current but its Stage D payload is 24h+ stale. The
//       dashboard's per-stage staleness check fires the "HubSpot data
//       unavailable" banner. The W2.3 watchdog MISSED this case because
//       it only checked snapshot freshness, not the per-stage rows.
//
// W2.4 extension: probe all 4 stage rows in pipeline_state plus the snapshot.
// Re-fire any stage that's stale beyond its expected refresh cadence. After
// stages are refreshed, recompose so the snapshot picks up the fresh data.
// Slack alert on outcome.

import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { composeSnapshot } from "@/lib/customer/refresh";
import {
  readPipelineStage,
  todaySnapshotDate,
} from "@/lib/customer/pipeline-state";

/** Subset of WatchdogStage the watchdog actively monitors + can re-fire.
 *  B2 exists in WatchdogStage for the legacy V2 dual-source path but no
 *  longer has its own cron and isn't on the dashboard read path. */
type WatchdogStage = "A" | "B" | "C" | "D";
import { postSlack } from "@/lib/customer/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Per-stage staleness thresholds. Hourly stages tolerate ~90 min; daily
 *  stages tolerate ~25h. Anything beyond → re-fire the stage. */
const STALE_HOURS = {
  A: 1.5,
  B: 25,
  C: 25,
  D: 25,
  snapshot: 25,
} as const;

/** Hardcoded order in which we re-fire stale stages. A must come first
 *  because B reads activeEntityIds from it. */
const STAGE_RUN_ORDER: WatchdogStage[] = ["A", "B", "C", "D"];

interface StageProbe {
  exists: boolean;
  ageHours: number | null;
  generatedAt: string | null;
  stale: boolean;
  errors: string[];
}

interface SnapshotProbe {
  exists: boolean;
  isToday: boolean;
  ageHours: number | null;
  generatedAt: string | null;
  stale: boolean;
}

async function probeStage(stage: WatchdogStage, today: string): Promise<StageProbe> {
  const row = await readPipelineStage(stage, today);
  if (!row) {
    return { exists: false, ageHours: null, generatedAt: null, stale: true, errors: [] };
  }
  const ageHours = (Date.now() - Date.parse(row.generatedAt)) / (60 * 60 * 1000);
  const threshold = STALE_HOURS[stage];
  return {
    exists: true,
    ageHours,
    generatedAt: row.generatedAt,
    stale: ageHours > threshold,
    errors: row.errors,
  };
}

async function probeSnapshot(): Promise<SnapshotProbe> {
  const snap = await readLatestSnapshotV2();
  if (!snap) {
    return {
      exists: false,
      isToday: false,
      ageHours: null,
      generatedAt: null,
      stale: true,
    };
  }
  const generatedAt = snap.generatedAt;
  const ageHours = (Date.now() - Date.parse(generatedAt)) / (60 * 60 * 1000);
  const today = todaySnapshotDate();
  const isToday = (generatedAt || "").slice(0, 10) === today;
  return {
    exists: true,
    isToday,
    ageHours,
    generatedAt,
    stale: ageHours > STALE_HOURS.snapshot,
  };
}

/**
 * Fire a single stage refresh by HTTP POST to its cron route. Each route
 * runs as its own function instance with its own memory budget, so the
 * watchdog stays lightweight (just coordinating).
 *
 * Returns success/failure + duration so we can report each stage's
 * outcome separately in the Slack alert.
 */
async function fireStage(
  stage: WatchdogStage,
  base: string,
  secret: string,
): Promise<{ stage: WatchdogStage; ok: boolean; status: number; ms: number; error?: string }> {
  const slug = stage === "A" ? "stage-a" : stage === "B" ? "stage-b" : stage === "C" ? "stage-c" : "stage-d";
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/api/cron/refresh/${slug}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
      // Each stage's own maxDuration governs the real budget; this is
      // just our client-side patience.
      signal: AbortSignal.timeout(290_000),
    });
    return { stage, ok: res.ok, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { stage, ok: false, status: -1, ms: Date.now() - t0, error: message };
  }
}

export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  const startedAt = new Date().toISOString();
  const today = todaySnapshotDate();

  // Probe everything in parallel
  const [probeA, probeB, probeC, probeD, probeSnap] = await Promise.all([
    probeStage("A", today),
    probeStage("B", today),
    probeStage("C", today),
    probeStage("D", today),
    probeSnapshot(),
  ]);
  const stageProbes = { A: probeA, B: probeB, C: probeC, D: probeD };
  const staleStages: WatchdogStage[] = STAGE_RUN_ORDER.filter((s) => stageProbes[s].stale);

  // Healthy case — everything fresh. No action.
  if (staleStages.length === 0 && !probeSnap.stale) {
    return NextResponse.json({
      ok: true,
      action: "no-op",
      reason: "all stages and snapshot are fresh",
      stages: stageProbes,
      snapshot: probeSnap,
    });
  }

  console.warn(
    `[refresh-watchdog] STALE detected — stages: ${staleStages.join(",") || "none"}` +
      `, snapshot stale: ${probeSnap.stale}`,
  );

  // Re-fire each stale stage, in dependency order (A first, then B/C/D).
  // We do them sequentially even though they could run in parallel — Vercel
  // free-tier accounts have limited concurrent function invocations, and
  // sequential keeps the failure modes legible.
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";
  const secret = process.env.CRON_SECRET || "";

  const stageResults: Array<Awaited<ReturnType<typeof fireStage>>> = [];
  for (const stage of staleStages) {
    const res = await fireStage(stage, base, secret);
    stageResults.push(res);
    if (!res.ok) {
      // Continue trying other stages; we'll report all failures.
      console.warn(`[refresh-watchdog] stage ${stage} re-fire failed:`, res);
    }
  }

  // Recompose so the snapshot picks up fresh stage data
  let composeError: string | null = null;
  let composeMs = 0;
  let recoveredSnapshot: { generatedAt: string; totalActive: number } | null = null;
  const composeStart = Date.now();
  try {
    const snap = await composeSnapshot();
    recoveredSnapshot = {
      generatedAt: snap.generatedAt,
      totalActive: snap.totalActive,
    };
    composeMs = Date.now() - composeStart;
  } catch (e) {
    composeError = e instanceof Error ? e.message : String(e);
    composeMs = Date.now() - composeStart;
    console.error(`[refresh-watchdog] compose recovery FAILED: ${composeError}`);
  }

  // Re-probe to confirm recovery
  const [probeA2, probeB2, probeC2, probeD2, probeSnap2] = await Promise.all([
    probeStage("A", today),
    probeStage("B", today),
    probeStage("C", today),
    probeStage("D", today),
    probeSnapshot(),
  ]);
  const stageProbes2 = { A: probeA2, B: probeB2, C: probeC2, D: probeD2 };
  const stillStale: WatchdogStage[] = STAGE_RUN_ORDER.filter((s) => stageProbes2[s].stale);
  const recovered = stillStale.length === 0 && !probeSnap2.stale && !composeError;

  // Slack alert
  const webhook = process.env.SLACK_WEBHOOK_URL;
  let slackPosted = false;
  if (webhook) {
    try {
      const lines: string[] = [];
      if (recovered) {
        lines.push(`:white_check_mark: *Beacon — refresh watchdog recovered staleness*`);
        lines.push(`Stale before: ${staleStages.join(", ") || "(snapshot only)"}`);
        for (const r of stageResults) {
          lines.push(`• Re-fired stage ${r.stage}: ${r.ok ? "OK" : `FAIL ${r.status}`} (${(r.ms / 1000).toFixed(1)}s)`);
        }
        lines.push(`Recompose: ${(composeMs / 1000).toFixed(1)}s`);
        lines.push(`New snapshot: ${probeSnap2.generatedAt}`);
      } else {
        lines.push(`:rotating_light: *Beacon — refresh watchdog could NOT fully recover*`);
        if (composeError) lines.push(`Compose threw: ${composeError}`);
        if (stillStale.length > 0) lines.push(`Still stale stages: ${stillStale.join(", ")}`);
        for (const r of stageResults) {
          if (!r.ok) {
            lines.push(`• Stage ${r.stage} re-fire FAILED: HTTP ${r.status} (${r.error || "unknown"}) after ${(r.ms / 1000).toFixed(1)}s`);
          }
        }
        lines.push(`Manual intervention needed. Investigate logs for failing stage.`);
      }
      lines.push(`Watchdog started ${startedAt}`);
      const result = await postSlack({ text: lines.join("\n") });
      slackPosted = result.sent;
    } catch (e) {
      console.warn("[refresh-watchdog] slack post failed:", e);
    }
  }

  return NextResponse.json({
    ok: recovered,
    action: recovered ? "recovered" : "recovery-incomplete",
    started_at: startedAt,
    stale_before: {
      stages: staleStages,
      snapshot: probeSnap.stale,
    },
    stage_refire_results: stageResults,
    compose_error: composeError,
    compose_ms: composeMs,
    recovered_snapshot: recoveredSnapshot,
    probe_after: {
      stages: stageProbes2,
      snapshot: probeSnap2,
      still_stale_stages: stillStale,
    },
    slack_posted: slackPosted,
    slack_configured: !!webhook,
  });
}

export const POST = GET;
