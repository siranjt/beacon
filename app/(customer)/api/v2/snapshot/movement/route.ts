import { NextRequest, NextResponse } from "next/server";
import { readStoplightMovement } from "@/lib/customer/postgres";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/snapshot/movement?days=7
 *   → stoplight movement between latest snapshot and N days ago.
 *     Buckets: flippedToRed, recoveries, degraded.
 *
 * Phase 33.B — admin + manager only (cross-AM rollup).
 */
export async function GET(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const url = new URL(req.url);
  const days = Math.max(1, Math.min(60, Number(url.searchParams.get("days") || 7)));
  try {
    const result = await readStoplightMovement(days);
    if (!result) {
      // Phase 33.H.6 — soft-fail with building_history flag instead of 404
      return NextResponse.json(
        {
          building_history: true,
          days,
          comparedAt: null,
          currentAt: null,
          flippedToRed: [],
          recoveries: [],
          degraded: [],
        },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
