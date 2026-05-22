import { NextRequest, NextResponse } from "next/server";
import { readCustomerActions, readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { getApiUser, requireAmScope, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/customer/:entityId/actions
 *   → returns the AM action log for this customer (most recent 20).
 *     Powers the drill-down modal's "Notes" tab.
 *
 * Phase 33.B — admin + manager bypass; AMs scoped to customers in their book.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: { entityId: string } },
) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  const { entityId } = ctx.params;
  try {
    // Look up customer's am_name from snapshot for per-AM scope enforcement.
    const snap = await readLatestSnapshotV2();
    if (!snap) {
      // Soft-fail: no snapshot → return 503 with a clear message.
      return NextResponse.json(
        { ok: false, error: "No snapshot available yet" },
        { status: 503 },
      );
    }
    const customer = snap.customers.find((c) => c.entity_id === entityId);
    if (!customer) {
      return NextResponse.json(
        { ok: false, error: "Customer not found in latest snapshot" },
        { status: 404 },
      );
    }
    const scopeDenied = requireAmScope(user, customer.am_name);
    if (scopeDenied) return scopeDenied;

    const rows = await readCustomerActions(entityId);
    return NextResponse.json({ entityId, rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
