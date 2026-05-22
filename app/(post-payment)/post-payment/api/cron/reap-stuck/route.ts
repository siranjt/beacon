/**
 * Watchdog cron: flips customers stuck in `processing` for too long to `failed`.
 *
 * Why this exists:
 *   The analyze pipeline runs inside `waitUntil` with maxDuration=600s (Pro +
 *   Fluid Compute). If a step hangs past that — Anthropic stream stalls, comms
 *   fetch wedges, function gets reaped by Vercel mid-execution — the row is
 *   left in `processing` forever. The dashboard then lies about active work,
 *   and the analyze idempotency guard (status === "ready" || "out_of_scope")
 *   doesn't catch `processing` either, so re-runs end up double-billing.
 *
 *   This cron resolves both: any `processing` row whose `updated_at` is older
 *   than STUCK_THRESHOLD_MINUTES gets flipped to `failed` with a clear reason.
 *   The next force re-run then has a clean starting state.
 *
 * Schedule:
 *   Every 10 minutes via vercel.json crons array.
 *
 * Auth:
 *   Standard Vercel cron `Authorization: Bearer ${CRON_SECRET}` header.
 *
 * Threshold tuning:
 *   - Bundle build: ~80s (worst case with slow Metabase)
 *   - Sonnet LLM: ~90–150s
 *   - Opus LLM: ~180–300s
 *   - Render + Slack: ~10s
 *   - Total happy path: 200–450s
 *   - 20 min (1200s) gives ~2.5× headroom over the worst real run. Anything
 *     above that is genuinely stuck.
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/post-payment/db/queries";
// Shared cron-auth helper (Phase E-7 standardization). Previously this
// route inlined its own CRON_SECRET check, which produced different error
// codes from customer-beacon crons when the secret was unset (401 vs 503).
// Centralizing the check makes the auth shape identical across the
// umbrella and refuses to run if CRON_SECRET is missing rather than
// silently accepting unauthenticated traffic.
import { requireCronAuth } from "@/lib/customer/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const STUCK_THRESHOLD_MINUTES = Number(process.env.STUCK_THRESHOLD_MINUTES ?? 20);

export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  // Find + flip stuck rows in a single statement; RETURNING gives us the list
  // for the response body + audit logging. We also stamp a failure_reason that
  // makes it obvious in the diag UI why this row was reaped (vs. a real LLM
  // failure with the actual error message).
  let reaped: Array<{
    cb_customer_id: string;
    biz_name: string | null;
    minutes_stuck: number;
    last_event: string | null;
  }>;
  try {
    const { rows } = await sql<{
      cb_customer_id: string;
      biz_name: string | null;
      minutes_stuck: number;
      last_event: string | null;
    }>`
      WITH stuck AS (
        SELECT cb_customer_id, biz_name,
               EXTRACT(EPOCH FROM (now() - updated_at)) / 60 AS minutes_stuck
        FROM customers
        WHERE status = 'processing'
          AND updated_at < now() - (${STUCK_THRESHOLD_MINUTES} || ' minutes')::interval
      ),
      flipped AS (
        UPDATE customers
        SET status = 'failed',
            failure_reason = 'watchdog_timeout: stuck in processing > '
              || ${STUCK_THRESHOLD_MINUTES}::text || ' minutes; pipeline likely killed mid-LLM. '
              || 'Re-run with POST /post-payment/api/analyze/[id]?force=true',
            failure_attempts = failure_attempts + 1
        WHERE cb_customer_id IN (SELECT cb_customer_id FROM stuck)
        RETURNING cb_customer_id
      )
      SELECT s.cb_customer_id,
             s.biz_name,
             s.minutes_stuck::int AS minutes_stuck,
             (SELECT kind FROM events e
              WHERE e.cb_customer_id = s.cb_customer_id
              ORDER BY created_at DESC LIMIT 1) AS last_event
        FROM stuck s
       WHERE s.cb_customer_id IN (SELECT cb_customer_id FROM flipped)
    `;
    reaped = rows;
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e), stage: "reap_query" },
      { status: 500 },
    );
  }

  // Log a watchdog event per reaped row so the diag endpoint shows exactly
  // when + why this happened (mirrors logEvent's contract). Best-effort.
  for (const r of reaped) {
    try {
      await sql`
        INSERT INTO events (cb_customer_id, kind, detail)
        VALUES (${r.cb_customer_id}, 'watchdog_reaped', ${JSON.stringify({
          minutes_stuck: r.minutes_stuck,
          last_event: r.last_event,
          threshold_minutes: STUCK_THRESHOLD_MINUTES,
        })}::jsonb)
      `;
    } catch {
      // ignore — audit trail is best-effort
    }
  }

  return NextResponse.json({
    ok: true,
    threshold_minutes: STUCK_THRESHOLD_MINUTES,
    reaped: reaped.length,
    customers: reaped,
  });
}
