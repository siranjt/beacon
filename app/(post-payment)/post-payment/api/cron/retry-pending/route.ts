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

  return NextResponse.json({
    ok: true,
    retried: pending.length,
    results,
  });
}
