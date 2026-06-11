/**
 * Hourly cron: retry analyze for customers stuck in `pending_entity` status.
 *
 * Set up in `vercel.json` to fire at the top of every hour. Triggered by
 * Vercel's cron runner with the `x-vercel-cron-signature` header (in addition
 * to the standard CRON_SECRET env-based bearer).
 *
 * The pipeline marks a customer `pending_entity` when bundle.entity_id_pending
 * is true (BaseSheet hasn't synced yet AND Chargebee cf_entity_id is empty).
 * This cron re-attempts the analyze call for each such customer; once BaseSheet
 * picks them up (typically within a few hours of signup), the retry succeeds
 * and the customer moves to "ready" or "failed".
 *
 * Safety:
 *  - Limit per run: DYNAMIC cap based on queue depth (OPT-8).
 *      - depth ≤ 50  → cap = 25 (default)
 *      - depth 51-100 → cap = 10
 *      - depth 101-200 → cap = 5  (deep back-off, queue clearly stuck)
 *      - depth > 200 → cap = 5  (same — never less than 5)
 *  - Per-customer streak: if a customer has failed 3 retries in a row, flip
 *    to `failed` instead of retrying again. Streak resets on success.
 *  - Slack alert: if queue depth > 5 AND it's been growing for 3 consecutive
 *    runs, post a wedged-queue notice. Uses event log to remember the last
 *    3 depths.
 *  - Each retry triggers POST /api/analyze/[id]?force=true via fetch.
 *  - Uses CRON_SECRET to authenticate (no user session involved).
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/post-payment/db/queries";
// Phase E-7 — shared cron-auth helper. See reap-stuck/route.ts for the
// rationale (consistent error codes + refuse-to-run when CRON_SECRET unset).
import { requireCronAuth } from "@/lib/customer/cron-auth";
// Phase E-11 (G6) — Slack alerting on stuck-pending customers.
// Uses SLACK_WEBHOOK_URL (vs lib/post-payment/slack which posts via
// SLACK_BOT_TOKEN with file uploads) — the existing pattern this cron
// already uses for G6 forever-pending alerts.
import { postSlack } from "@/lib/customer/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// OPT-8: dynamic queue-depth-based cap.
const DEFAULT_MAX_PER_RUN = 25;
const STREAK_FAIL_THRESHOLD = 3;
const WEDGED_QUEUE_DEPTH_THRESHOLD = 5;
const WEDGED_GROWING_RUNS = 3;

/**
 * OPT-8: queue-depth-aware cap. Smaller cap when the queue is large because a
 * large queue almost always means we're burning Sonnet calls on wedged rows.
 */
function capForDepth(depth: number): number {
  if (depth > 100) return 5;
  if (depth > 50) return 10;
  return DEFAULT_MAX_PER_RUN;
}

function getBaseUrl(req: NextRequest): string {
  // Prefer the explicit public app URL; fall back to the request host.
  const envUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (envUrl) return envUrl.replace(/\/$/, "");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  // Phase E-7 — use shared requireCronAuth helper. Matches reap-stuck and
  // refuses to run when CRON_SECRET is unset (vs. the old inline check which
  // silently let unauthenticated calls through in that case).
  const denied = requireCronAuth(req);
  if (denied) return denied;

  // --------------------------------------------------------------------------
  // OPT-8 (1) — measure queue depth, derive the dynamic cap.
  // --------------------------------------------------------------------------
  let queueDepth = 0;
  try {
    const { rows } = await sql<{ depth: number }>`
      SELECT COUNT(*)::int AS depth
      FROM customers
      WHERE status = 'pending_entity'
        AND retry_failure_streak < ${STREAK_FAIL_THRESHOLD}
    `;
    queueDepth = rows[0]?.depth ?? 0;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg, stage: "queue_depth" },
      { status: 500 },
    );
  }

  const maxPerRun = capForDepth(queueDepth);

  // --------------------------------------------------------------------------
  // OPT-8 (3) — wedged-queue Slack alert.
  // Look at the last 3 queue-depth event rows; if depth grew in each of the
  // last 3 runs AND today's depth is over the threshold, fire one alert.
  // Always record today's depth so the next run sees it.
  // --------------------------------------------------------------------------
  let wedgedAlertSent = false;
  try {
    const { rows: priorRuns } = await sql<{ depth: number }>`
      SELECT (detail->>'queue_depth')::int AS depth
      FROM events
      WHERE kind = 'retry_pending_run'
      ORDER BY created_at DESC
      LIMIT 3
    `;
    const priorDepths: number[] = (priorRuns as { depth: number }[])
      .map((r) => r.depth)
      .filter((d): d is number => typeof d === "number" && !Number.isNaN(d));

    // Growing means the most recent N depths form a strictly non-decreasing
    // sequence ending at today's depth. priorDepths is newest-first; reverse
    // so the comparison reads chronologically.
    const recentChronological = [...priorDepths].reverse();
    const series = [...recentChronological, queueDepth];
    let growing = series.length >= WEDGED_GROWING_RUNS;
    for (let i = 1; growing && i < series.length; i += 1) {
      if (series[i] < series[i - 1]) growing = false;
    }

    if (
      queueDepth > WEDGED_QUEUE_DEPTH_THRESHOLD &&
      growing &&
      priorDepths.length >= WEDGED_GROWING_RUNS - 1
    ) {
      // Rough cost projection: each retry triggers one Sonnet analyze.
      // We've been seeing ~$4 per analyze call. Cap-of-the-hour × 24h.
      const dailyCalls = maxPerRun * 24;
      const costPerDay = dailyCalls * 4;
      const trend = series.join(" → ");
      try {
        await postSlack({
          text: `:rotating_light: Post-payment retry queue wedged: ${queueDepth} customers`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: ":rotating_light: Post-Payment — retry queue wedged",
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text:
                  `Post-payment retry queue depth: *${queueDepth} customers* wedged.\n` +
                  `Cron is throttling — investigate which customers are failing repeatedly.\n\n` +
                  `*Depth trend (last ${series.length} runs):* ${trend}\n` +
                  `*This-run cap:* ${maxPerRun} (down from ${DEFAULT_MAX_PER_RUN}).\n` +
                  `*Cost impact:* ~$${costPerDay}/day at current rate ` +
                  `(${maxPerRun} retries/hr × 24h × ~$4/analyze).\n\n` +
                  `Check \`/post-payment/diag/health\` and any customer in ` +
                  `\`pending_entity\` with \`retry_failure_streak ≥ 2\` is a near-flip candidate.`,
              },
            },
          ],
        });
        wedgedAlertSent = true;
      } catch (slackErr: unknown) {
        const slackMsg =
          slackErr instanceof Error ? slackErr.message : String(slackErr);
        console.error("[retry-pending OPT-8] wedged alert failed:", slackMsg);
      }
    }

    // Record today's depth so the next run sees it (always — even if no
    // alert fired). Bind to a sentinel cb_customer_id of `_system` if FK
    // allows nulls; otherwise pass null since cb_customer_id is nullable
    // (REFERENCES … ON DELETE CASCADE, but the column itself is nullable
    // in schema.sql).
    await sql`
      INSERT INTO events (cb_customer_id, kind, detail)
      VALUES (
        NULL,
        'retry_pending_run',
        ${JSON.stringify({
          queue_depth: queueDepth,
          cap_used: maxPerRun,
          wedged_alert_sent: wedgedAlertSent,
          at: new Date().toISOString(),
        })}::jsonb
      )
    `;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[retry-pending OPT-8] depth trend check failed:", msg);
  }

  // --------------------------------------------------------------------------
  // Fetch the work list, excluding rows that already crossed the streak
  // threshold (those get flipped to `failed` below in a single statement).
  // --------------------------------------------------------------------------
  let pending: {
    cb_customer_id: string;
    biz_name: string | null;
    created_at: string;
    retry_failure_streak: number;
  }[];
  try {
    const { rows } = await sql<{
      cb_customer_id: string;
      biz_name: string | null;
      created_at: string;
      retry_failure_streak: number;
    }>`
      SELECT cb_customer_id, biz_name, created_at, retry_failure_streak
      FROM customers
      WHERE status = 'pending_entity'
        AND retry_failure_streak < ${STREAK_FAIL_THRESHOLD}
      ORDER BY created_at ASC
      LIMIT ${maxPerRun}
    `;
    pending = rows;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg, stage: "list_pending" },
      { status: 500 },
    );
  }

  // OPT-8 (2) — flip any customers that already hit the streak threshold to
  // `failed` so they stop appearing in retry queues. This is idempotent — the
  // WHERE clause guarantees we only flip rows still in pending_entity.
  let flippedFailed: { cb_customer_id: string; streak: number }[] = [];
  try {
    const { rows: flipped } = await sql<{
      cb_customer_id: string;
      streak: number;
    }>`
      UPDATE customers
      SET status = 'failed',
          failure_reason = 'opt8_retry_streak: ' || retry_failure_streak::text ||
            ' consecutive retry failures — flipped to failed by retry-pending cron. ' ||
            'Manual re-run with POST /post-payment/api/analyze/[id]?force=true once root cause known.',
          failure_attempts = failure_attempts + 1
      WHERE status = 'pending_entity'
        AND retry_failure_streak >= ${STREAK_FAIL_THRESHOLD}
      RETURNING cb_customer_id, retry_failure_streak AS streak
    `;
    flippedFailed = flipped;
    for (const f of flippedFailed) {
      try {
        await sql`
          INSERT INTO events (cb_customer_id, kind, detail)
          VALUES (
            ${f.cb_customer_id},
            'opt8_streak_flipped_failed',
            ${JSON.stringify({ streak: f.streak, at: new Date().toISOString() })}::jsonb
          )
        `;
      } catch {
        // best-effort audit only
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[retry-pending OPT-8] streak flip failed:", msg);
  }

  if (pending.length === 0) {
    return NextResponse.json({
      ok: true,
      retried: 0,
      queue_depth: queueDepth,
      cap_used: maxPerRun,
      streak_flipped_failed: flippedFailed.length,
      wedged_alert_sent: wedgedAlertSent,
      note: "no customers in pending_entity status",
    });
  }

  const baseUrl = getBaseUrl(req);
  // Forward a service token so the analyze route's NextAuth gate lets the
  // cron-initiated retries through. We use the same CRON_SECRET as a
  // bearer-style bypass header that the analyze endpoint recognizes.
  // (If CRON_SECRET isn't configured, the call will 401 — that's fine,
  // the cron just becomes a no-op rather than a security hole.)
  const headers: Record<string, string> = {
    "x-zoca-cron-secret": process.env.CRON_SECRET ?? "",
  };

  const results: Array<{
    cb_customer_id: string;
    status: number;
    ok: boolean;
    new_streak: number;
  }> = [];
  for (const c of pending) {
    let ok = false;
    let httpStatus = 0;
    try {
      const r = await fetch(
        `${baseUrl}/post-payment/api/analyze/${c.cb_customer_id}?force=true`,
        { method: "POST", headers, cache: "no-store" },
      );
      ok = r.ok;
      httpStatus = r.status;
    } catch {
      ok = false;
      httpStatus = 0;
    }

    // OPT-8 (2) — streak bookkeeping. We treat a non-2xx response (or a thrown
    // fetch) as a failure for streak purposes. Success path resets to 0.
    let newStreak = c.retry_failure_streak;
    try {
      if (ok) {
        const { rows: u } = await sql<{ retry_failure_streak: number }>`
          UPDATE customers
          SET retry_failure_streak = 0
          WHERE cb_customer_id = ${c.cb_customer_id}
          RETURNING retry_failure_streak
        `;
        newStreak = u[0]?.retry_failure_streak ?? 0;
      } else {
        const { rows: u } = await sql<{ retry_failure_streak: number }>`
          UPDATE customers
          SET retry_failure_streak = retry_failure_streak + 1
          WHERE cb_customer_id = ${c.cb_customer_id}
          RETURNING retry_failure_streak
        `;
        newStreak = u[0]?.retry_failure_streak ?? c.retry_failure_streak + 1;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[retry-pending OPT-8] streak update for ${c.cb_customer_id} failed:`,
        msg,
      );
    }

    results.push({
      cb_customer_id: c.cb_customer_id,
      status: httpStatus,
      ok,
      new_streak: newStreak,
    });
  }

  // -------------------------------------------------------------------------
  // Phase E-11 (G6) — Forever-pending alert.
  // Customers in pending_entity for >48h are likely stuck because their
  // entity_id never made it into BaseSheet. Without this, the retry loop
  // would run forever silently. Fire a single Slack alert per customer and
  // record an `entity_id_missing_alerted` event so we don't spam.
  // -------------------------------------------------------------------------
  let alertsSent = 0;
  try {
    const { rows: stuck } = await sql<{
      cb_customer_id: string;
      biz_name: string | null;
      email: string | null;
      created_at: string;
      hours_pending: number;
    }>`
      SELECT
        c.cb_customer_id,
        c.biz_name,
        c.email,
        c.created_at,
        EXTRACT(EPOCH FROM (NOW() - c.created_at)) / 3600 AS hours_pending
      FROM customers c
      WHERE c.status = 'pending_entity'
        AND c.created_at < NOW() - INTERVAL '48 hours'
        AND NOT EXISTS (
          SELECT 1 FROM events e
          WHERE e.cb_customer_id = c.cb_customer_id
            AND e.kind = 'entity_id_missing_alerted'
        )
      ORDER BY c.created_at ASC
      LIMIT 25
    `;
    for (const s of stuck) {
      const hours = Math.floor(Number(s.hours_pending));
      const label = s.biz_name ? `*${s.biz_name}*` : `*${s.cb_customer_id}*`;
      const meta = s.email ? `<${s.email}>` : "(no email)";
      try {
        await postSlack({
          text: `:warning: Post-Payment customer stuck in pending_entity for ${hours}h: ${s.biz_name ?? s.cb_customer_id}`,
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: ":warning: Post-Payment — entity_id never resolved" },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text:
                  `${label} ${meta}\n` +
                  `Customer ID: \`${s.cb_customer_id}\`\n` +
                  `Pending for: *${hours}h* (since ${new Date(s.created_at).toISOString()})\n\n` +
                  `BaseSheet hasn't picked up the entity_id. Manual investigation needed — ` +
                  `the retry loop is firing hourly but won't make progress until BaseSheet syncs.`,
              },
            },
          ],
        });
        // Record the alert so we only fire once per customer.
        await sql`
          INSERT INTO events (cb_customer_id, kind, detail)
          VALUES (
            ${s.cb_customer_id},
            'entity_id_missing_alerted',
            ${JSON.stringify({ hours_pending: hours, alerted_at: new Date().toISOString() })}::jsonb
          )
        `;
        alertsSent++;
      } catch (e: unknown) {
        // Slack errors don't abort the loop — keep alerting the others.
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[retry-pending G6] alert for ${s.cb_customer_id} failed:`,
          msg,
        );
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[retry-pending G6] stuck-pending check failed:", msg);
  }

  return NextResponse.json({
    ok: true,
    retried: pending.length,
    queue_depth: queueDepth,
    cap_used: maxPerRun,
    streak_flipped_failed: flippedFailed.length,
    wedged_alert_sent: wedgedAlertSent,
    results,
    stuckAlertsSent: alertsSent,
  });
}
