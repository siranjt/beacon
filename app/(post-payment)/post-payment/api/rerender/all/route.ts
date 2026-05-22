/**
 * Bulk re-renderer — re-builds every existing customer's Word document from
 * their stored reportData JSON using the current template.js renderer.
 *
 * Use this after a template change to regenerate all docx files in one shot.
 * No LLM calls, no Chargebee/Metabase fetches.
 *
 * POST /api/rerender/all
 * POST /api/rerender/all?dry_run=true   → list customers that would be rerendered, but don't actually render
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/post-payment/db/queries";
// Phase E-7 — dual auth (NextAuth session OR CRON_SECRET bearer). See
// lib/post-payment/admin-auth.ts. Lets ops scripts bulk-rerender via curl.
import { requireAdminAuth } from "@/lib/post-payment/admin-auth";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const authFail = await requireAdminAuth(req);
  if (authFail) return authFail;
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";

  // List all customers with reportData (i.e., they were analyzed at some point)
  const { rows } = await sql`
    SELECT cb_customer_id, biz_name, status, verdict, report_blob_json_url, updated_at
    FROM customers
    WHERE report_blob_json_url IS NOT NULL
    ORDER BY updated_at DESC
  `;
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, count: 0, customers: [], message: "no customers with reportData" });
  }
  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      count: rows.length,
      customers: rows.map((r: any) => ({
        cb_customer_id: r.cb_customer_id,
        biz_name: r.biz_name,
        status: r.status,
        verdict: r.verdict,
      })),
    });
  }

  // Trigger rerender for each customer sequentially (small N expected; can
  // parallelize if needed). We POST to /api/rerender/[id] so each rerender
  // gets its own function invocation budget.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.get("host")}`;
  const results: any[] = [];
  for (const r of rows as any[]) {
    try {
      const res = await fetch(`${baseUrl}/api/rerender/${r.cb_customer_id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const j: any = await res.json().catch(() => ({}));
      results.push({
        cb_customer_id: r.cb_customer_id,
        biz_name: r.biz_name,
        ok: j.ok ?? false,
        elapsed_ms: j.elapsed_ms ?? null,
        error: j.error ?? null,
      });
    } catch (e: any) {
      results.push({ cb_customer_id: r.cb_customer_id, biz_name: r.biz_name, ok: false, error: e.message });
    }
  }

  const okCount = results.filter(r => r.ok).length;
  return NextResponse.json({
    ok: true,
    total: results.length,
    succeeded: okCount,
    failed: results.length - okCount,
    results,
  });
}
