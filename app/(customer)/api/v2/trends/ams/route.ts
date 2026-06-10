import { NextRequest, NextResponse } from "next/server";
import { readMultipleAmBookTrends } from "@/lib/customer/postgres";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/trends/ams?days=14&ams=Sudha+Goutami,Hubern+C
 *   → bundled per-AM book trend in a single SQL pass.
 *
 * Phase 33.B — admin + manager only (cross-AM rollup).
 */
export async function GET(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const url = new URL(req.url);
  const days = Math.max(7, Math.min(90, Number(url.searchParams.get("days") || 14)));
  const amsParam = url.searchParams.get("ams") || "";
  const ams = amsParam
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!ams.length) {
    return NextResponse.json({ error: "ams query param required" }, { status: 400 });
  }
  if (ams.length > 25) {
    return NextResponse.json({ error: "max 25 AMs per request" }, { status: 400 });
  }
  try {
    const data = await readMultipleAmBookTrends(ams, days);
    return NextResponse.json(
      { days, ams, data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
