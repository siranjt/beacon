import { NextRequest, NextResponse } from "next/server";
import { entitiesContactedRecently } from "@/lib/customer/postgres";
import { getApiUser, requireAmScope } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/am/:amName/contacted-recently?days=7
 *   → list of entity_ids the AM has logged a 'contacted_*' action against
 *     in the last N days. Powers the dimmed-card / 'already contacted'
 *     affordance on V2AMTriage so the AM doesn't double-call.
 *
 * Phase 33.B — admin + manager bypass; AMs must request their own am_name.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: { amName: string } },
) {
  const user = await getApiUser();
  const am = decodeURIComponent(ctx.params.amName);
  const denied = requireAmScope(user, am);
  if (denied) return denied;

  const url = new URL(req.url);
  const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days") || 7)));
  try {
    const set = await entitiesContactedRecently(am, days);
    return NextResponse.json(
      { am_name: am, days, entity_ids: Array.from(set) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
