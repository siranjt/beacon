import { NextRequest, NextResponse } from "next/server";
import { readCustomerTrend, readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { getApiUser, requireAmScope, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/customer/:entityId/trend?days=84
 *   → per-customer composite-score timeseries.
 *
 * Phase 33.B — admin + manager bypass; AMs scoped to customers in their book.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: { entityId: string } },
) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  const url = new URL(req.url);
  const days = Math.max(7, Math.min(365, Number(url.searchParams.get("days") || 84)));
  try {
    const snap = await readLatestSnapshotV2();
    if (!snap) {
      return NextResponse.json(
        { ok: false, error: "No snapshot available yet" },
        { status: 503 },
      );
    }
    const customer = snap.customers.find((c) => c.entity_id === ctx.params.entityId);
    if (!customer) {
      return NextResponse.json(
        { ok: false, error: "Customer not found in latest snapshot" },
        { status: 404 },
      );
    }
    const scopeDenied = requireAmScope(user, customer.am_name);
    if (scopeDenied) return scopeDenied;

    const points = await readCustomerTrend(ctx.params.entityId, days);
    return NextResponse.json(
      { entity_id: ctx.params.entityId, days, points },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
