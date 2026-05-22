/**
 * Cross-customer diagnostic — dumps the customers table and the latest 50
 * events across ALL customers (no filter). Use this to find orphan events
 * that don't show up in a per-customer diag.
 *
 * GET /api/diag/all
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/post-payment/db/queries";
// Phase E-7 — dual auth (NextAuth session OR CRON_SECRET bearer). See
// lib/post-payment/admin-auth.ts. Lets ops curl diag without a browser.
import { requireAdminAuth } from "@/lib/post-payment/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authFail = await requireAdminAuth(req);
  if (authFail) return authFail;
  try {
    const { rows: customers } = await sql`
      SELECT
        cb_customer_id, biz_name, am_name, scope, status, verdict, failure_reason,
        created_at, updated_at
      FROM customers
      ORDER BY created_at DESC
    `;
    const { rows: events } = await sql`
      SELECT id, cb_customer_id, kind, detail, created_at
      FROM events
      ORDER BY id DESC
      LIMIT 50
    `;
    return NextResponse.json({
      ok: true,
      customers,
      latest_events: events,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
