import { NextRequest, NextResponse } from "next/server";
import { readMultipleCustomerTrends } from "@/lib/customer/postgres";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/trends/customers?days=14&ids=ent1,ent2,ent3
 *   → bundled per-customer composite-score trend.
 *     Max 200 entity_ids per request to keep response size sane.
 *
 * Phase 33.B — admin + manager only (cross-AM rollup; AMs use per-customer
 * /api/v2/customer/[entityId]/trend which is per-AM scoped).
 */
export async function GET(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const url = new URL(req.url);
  const days = Math.max(7, Math.min(90, Number(url.searchParams.get("days") || 14)));
  const idsParam = url.searchParams.get("ids") || "";
  const ids = idsParam
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!ids.length) {
    return NextResponse.json({ error: "ids query param required" }, { status: 400 });
  }
  if (ids.length > 200) {
    return NextResponse.json({ error: "max 200 customer ids per request" }, { status: 400 });
  }
  try {
    const data = await readMultipleCustomerTrends(ids, days);
    return NextResponse.json(
      { days, count: ids.length, data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
