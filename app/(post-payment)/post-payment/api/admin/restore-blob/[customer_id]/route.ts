/**
 * Admin recovery endpoint — uploads a reportData JSON object (POST body) to
 * the customer's expected Blob URL, then calls the rerender pipeline. Used
 * when the Blob got deleted but the DB still has a valid verdict; lets us
 * restore the docx without paying for a fresh LLM run.
 *
 * POST /api/admin/restore-blob/[customer_id]
 *   body: full reportData JSON (top-level keys: meta, exec, section1, ...)
 *
 * Returns the new docx_url. Pair with /api/rerender/[customer_id] after to
 * regenerate the docx with the current template.
 */

import { NextRequest, NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import { setCustomerReport, logEvent, getCustomer } from "@/lib/post-payment/db/queries";
// Phase E-7 — dual auth (NextAuth session OR CRON_SECRET bearer). See
// lib/post-payment/admin-auth.ts for the rationale. Lets ops scripts call
// the recovery endpoint via curl without a browser session.
import { requireAdminAuth } from "@/lib/post-payment/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function putAtFixedKey(key: string, body: string, contentType: string) {
  const opts = { access: "public" as const, contentType, addRandomSuffix: false };
  try {
    return await put(key, body, opts);
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (msg.includes("already exists") || msg.includes("blob exists")) {
      await del(key).catch(() => undefined);
      return await put(key, body, opts);
    }
    throw e;
  }
}

export async function POST(req: NextRequest, ctx: { params: { customer_id: string } }) {
  const authFail = await requireAdminAuth(req);
  if (authFail) return authFail;
  const customerId = ctx.params.customer_id;
  if (!customerId) {
    return NextResponse.json({ ok: false, error: "missing_customer_id" }, { status: 400 });
  }
  const cust = await getCustomer(customerId);
  if (!cust) {
    return NextResponse.json({ ok: false, error: "customer_not_found" }, { status: 404 });
  }
  let reportData: any;
  try {
    reportData = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json_body" }, { status: 400 });
  }
  if (!reportData || typeof reportData !== "object" || !reportData.exec) {
    return NextResponse.json({ ok: false, error: "body must be a reportData object with at least an `exec` field" }, { status: 400 });
  }

  await logEvent(customerId, "admin_restore_blob_started", {});
  const key = `reports/${customerId}.report_data.json`;
  let res;
  try {
    res = await putAtFixedKey(key, JSON.stringify(reportData, null, 2), "application/json");
    await logEvent(customerId, "admin_restore_blob_done", { url: res.url });
  } catch (e: any) {
    await logEvent(customerId, "admin_restore_blob_failed", { error: e.message });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
  await setCustomerReport(customerId, {
    report_blob_json_url: res.url,
  });
  return NextResponse.json({
    ok: true,
    customer_id: customerId,
    json_url: res.url,
    next_step: `curl -X POST https://zoca-payment-dashboard.vercel.app/api/rerender/${customerId}`,
  });
}
