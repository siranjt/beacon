// Phase E-19 W2.3 — daily-refresh watchdog.
//
// Runs 30 min after the daily compose cron (22:35 UTC). Checks whether
// today's snapshot exists in dashboard_snapshots. If missing or older
// than the configurable staleness window, fires composeSnapshot which
// auto-runs any missing upstream stages (A/B/C/D). Posts to Slack on
// both success ("watchdog recovered stale snapshot") and failure
// ("watchdog could not recover — manual intervention needed").
//
// Why this exists: the daily 22:00 UTC cron chain has silently failed
// multiple times because (a) compose was capped at 60s and got killed,
// (b) Stage B OOMed under V1's 5-CSV memory pressure, (c) Stage D
// HubSpot intermittently times out. No user-visible alert fires — the
// only signal is the "Snapshot is Xd ago" banner on the dashboard.
//
// The watchdog closes that gap.

import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { composeSnapshot } from "@/lib/customer/refresh";
import { todaySnapshotDate } from "@/lib/customer/pipeline-state";
import { postSlack } from "@/lib/customer/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** A snapshot older than this many hours is considered stale even if it
 *  technically exists for today. Tuned to allow ~3h drift past the
 *  scheduled 22:00 UTC compose. */
const STALE_AFTER_HOURS = 25;

interface SnapshotProbe {
  exists: boolean;
  isToday: boolean;
  ageHours: number | null;
  generatedAt: string | null;
}

async function probeSnapshot(): Promise<SnapshotProbe> {
  const snap = await readLatestSnapshotV2();
  if (!snap) {
    return { exists: false, isToday: false, ageHours: null, generatedAt: null };
  }
  const generatedAt = snap.generatedAt;
  const ageMs = Date.now() - Date.parse(generatedAt);
  const ageHours = ageMs / (60 * 60 * 1000);
  const today = todaySnapshotDate();
  const isToday = (generatedAt || "").slice(0, 10) === today;
  return { exists: true, isToday, ageHours, generatedAt };
}

export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  const startedAt = new Date().toISOString();
  const probe1 = await probeSnapshot();

  // Healthy case — today's snapshot exists and is fresh. No action.
  if (probe1.isToday && (probe1.ageHours ?? 999) < STALE_AFTER_HOURS) {
    return NextResponse.json({
      ok: true,
      action: "no-op",
      reason: "snapshot is today and fresh",
      probe: probe1,
    });
  }

  // Stale or missing. Attempt recovery.
  const reason = !probe1.exists
    ? "no snapshot at all"
    : !probe1.isToday
    ? `latest snapshot is ${probe1.generatedAt} (not today)`
    : `snapshot age ${probe1.ageHours?.toFixed(1)}h > ${STALE_AFTER_HOURS}h ceiling`;

  console.warn(`[refresh-watchdog] STALE: ${reason}. Firing composeSnapshot to recover.`);

  let recoveredSnapshot: { generatedAt: string; totalActive: number } | null = null;
  let recoveryError: string | null = null;
  const recoveryStartMs = Date.now();
  try {
    // composeSnapshot will auto-run any missing upstream stages (A/B/C/D)
    // via its internal compensating logic. Returns the new Snapshot.
    const snap = await composeSnapshot();
    recoveredSnapshot = {
      generatedAt: snap.generatedAt,
      totalActive: snap.totalActive,
    };
  } catch (e) {
    recoveryError = e instanceof Error ? e.message : String(e);
    console.error(`[refresh-watchdog] compose recovery FAILED: ${recoveryError}`);
  }
  const recoveryMs = Date.now() - recoveryStartMs;

  // Confirm recovery succeeded by probing again
  const probe2 = await probeSnapshot();
  const recovered = probe2.isToday && (probe2.ageHours ?? 999) < STALE_AFTER_HOURS;

  // Slack alert in both directions so ops sees what happened
  const webhook = process.env.SLACK_WEBHOOK_URL;
  let slackPosted = false;
  if (webhook) {
    try {
      const lines: string[] = [];
      if (recovered) {
        lines.push(`:white_check_mark: *Beacon — refresh watchdog recovered stale snapshot*`);
        lines.push(`Was: ${reason}`);
        lines.push(`Now: ${probe2.generatedAt} (age ${probe2.ageHours?.toFixed(1)}h)`);
        lines.push(`Recovery took ${(recoveryMs / 1000).toFixed(1)}s`);
      } else {
        lines.push(`:rotating_light: *Beacon — refresh watchdog could NOT recover stale snapshot*`);
        lines.push(`Was: ${reason}`);
        if (recoveryError) lines.push(`Compose threw: ${recoveryError}`);
        if (!recoveryError) lines.push(`Compose completed but probe still stale (age ${probe2.ageHours?.toFixed(1)}h)`);
        lines.push(`Manual intervention needed. Run /api/cron/refresh after fixing root cause.`);
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
    action: recovered ? "recovered" : "recovery-failed",
    reason,
    probe_before: probe1,
    probe_after: probe2,
    recovery_error: recoveryError,
    recovery_ms: recoveryMs,
    recovered_snapshot: recoveredSnapshot,
    slack_posted: slackPosted,
    slack_configured: !!webhook,
  });
}

export const POST = GET;
