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
 *  - Limit per run: 25 customers (avoids long function executions)
 *  - Stop after 25 to leave room for newer pending customers next hour
 *  - Each retry triggers POST /api/analyze/[id]?force=true via fetch
 *  - Uses CRON_SECRET to authenticate (no user session involved)
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/post-payment/db/queries";
// Phase E-7 — shared cron-auth helper. See reap-stuck/route.ts for the
// rationale (consistent error codes + refuse-to-run when CRON_SECRET unset).
import { requireCronAuth } from "@/lib/customer/cron-auth";
// Phase E-11 (G6) — Slack alerting on stuck-pending customers.
import { postSlack } from "@/lib/customer/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PER_RUN = 25;

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

  let pending: { cb_customer_id: string; biz_name: string | null; created_at: string }[];
  try {
    const { rows } = await sql<{
      cb_customer_id: string;
      biz_name: string | null;
      created_at: string;
    }>`
      SELECT cb_customer_id, biz_name, created_at
      FROM customers
      WHERE status = 'pending_entity'
      ORDER BY created_at ASC
      LIMIT ${MAX_PER_RUN}
    `;
    pending = rows;
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e), stage: "list_pending" },
      { status: 500 },
    );
  }

  if (pending.length === 0) {
    return NextResponse.json({
      ok: true,
      retried: 0,
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
  }> = [];
  for (const c of pending) {
    try {
      const r = await fetch(
        `${baseUrl}/post-payment/api/analyze/${c.cb_customer_id}?force=true`,
        { method: "POST", headers, cache: "no-store" },
      );
      results.push({
        cb_customer_id: c.cb_customer_id,
        status: r.status,
        ok: r.ok,
      });
    } catch (e: any) {
      results.push({
        cb_customer_id: c.cb_customer_id,
        status: 0,
        ok: false,
      });
    }
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
      } catch (e: any) {
        // Slack errors don't abort the loop — keep alerting the others.
        console.error(
          `[retry-pending G6] alert for ${s.cb_customer_id} failed:`,
          e?.message ?? String(e),
        );
      }
    }
  } catch (e: any) {
    console.error(
      "[retry-pending G6] stuck-pending check failed:",
      e?.message ?? String(e),
    );
  }

  return NextResponse.json({
    ok: true,
    retried: pending.length,
    results,
    stuckAlertsSent: alertsSent,
  });
}
