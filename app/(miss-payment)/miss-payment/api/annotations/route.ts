/**
 * Miss Payment Beacon — annotations CRUD.
 *
 * GET  /miss-payment/api/annotations           → AnnotationsMap
 * POST /miss-payment/api/annotations           → upsert a patch
 *      body: { invoiceNumber: string, patch: InvoiceAnnotation }
 *
 * Auth: admin + manager only (same gate as the dashboard).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAllAnnotations, setAnnotation } from "@/lib/miss-payment/annotations";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getApiUser();
  // 2026-06-12 — opened to AMs alongside the page + invoices route.
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;

  try {
    const annotations = await getAllAnnotations();
    return NextResponse.json({ annotations });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getApiUser();
  // 2026-06-12 — opened to AMs alongside the page + invoices route.
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;

  try {
    const body = await req.json();
    const invoiceNumber: string = body.invoiceNumber;
    const patch = body.patch || {};
    if (!invoiceNumber) {
      return NextResponse.json({ error: "invoiceNumber required" }, { status: 400 });
    }
    const merged = await setAnnotation(invoiceNumber, patch);
    return NextResponse.json({ ok: true, annotation: merged });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
