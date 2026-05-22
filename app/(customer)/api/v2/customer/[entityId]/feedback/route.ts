import { NextRequest, NextResponse } from "next/server";
import { readFeedbackForEntity, readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { getApiUser, requireAmScope, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/customer/:entityId/feedback
 *   → returns "this is wrong" feedback rows for this customer.
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
    const snap = await readLatestSnapshotV2();
    if (!snap) {
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

    const rows = await readFeedbackForEntity(entityId);
    return NextResponse.json({ entityId, rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
