import { NextRequest, NextResponse } from "next/server";
import { listSnapshotDates } from "@/lib/customer/postgres";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/snapshot/dates?limit=30
 *   → returns up to N available snapshot dates (most recent first).
 *     Powers the snapshot date picker in /v2/manager.
 *
 * Phase 33.B — admin + manager only (Manager view feature).
 */
export async function GET(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(90, Number(url.searchParams.get("limit") || 30)));
  try {
    const dates = await listSnapshotDates(limit);
    return NextResponse.json(
      { dates },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
