/**
 * Admin delete endpoint — removes a customer row + its events from the DB.
 * Use for cleaning up test/erroneous records (e.g. the literal "<id>" row
 * that got created from a malformed curl). Doesn't touch Blob storage.
 *
 * POST /api/admin/delete-customer/[customer_id]
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { sql } from "@/lib/post-payment/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  return session ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function POST(_req: NextRequest, ctx: { params: { customer_id: string } }) {
  const authFail = await requireAuth();
  if (authFail) return authFail;
  const customerId = ctx.params.customer_id;
  if (!customerId) {
    return NextResponse.json({ ok: false, error: "missing_customer_id" }, { status: 400 });
  }
  try {
    const eventsRes = await sql`DELETE FROM events WHERE cb_customer_id = ${customerId} RETURNING id`;
    const custRes = await sql`DELETE FROM customers WHERE cb_customer_id = ${customerId} RETURNING cb_customer_id`;
    return NextResponse.json({
      ok: true,
      customer_id: customerId,
      events_deleted: eventsRes.rowCount ?? eventsRes.rows.length,
      customer_deleted: (custRes.rowCount ?? custRes.rows.length) > 0,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
