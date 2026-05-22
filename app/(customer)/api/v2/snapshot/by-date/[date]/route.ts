import { NextRequest, NextResponse } from "next/server";
import { readSnapshotByDate } from "@/lib/customer/postgres";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/snapshot/by-date/:date   (date in YYYY-MM-DD)
 *   → returns the snapshot for that specific date, 404 if none.
 *     Used by the Leadership view's trend chart drilldown.
 *
 * Phase 33.B — admin + manager only (cross-AM rollup).
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: { date: string } },
) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const { date } = ctx.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  try {
    const snap = await readSnapshotByDate(date);
    if (!snap) return NextResponse.json({ error: "no snapshot for date" }, { status: 404 });
    return NextResponse.json(snap, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
