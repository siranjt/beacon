/**
 * Shadow verdict admin — per-entity time series.
 *
 * GET /api/admin/shadow-verdict/entity/[entityId]
 *
 * Returns the last 28 days of (deterministic_tier, llm_tier) per day for
 * one entity — used by the admin click-through view to see if the LLM
 * verdict has been stable or flip-flopping.
 *
 * Auth: manager + admin only.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail, isManagerOrAdmin } from "@/lib/customer/config";
import { getEntityVerdictHistory } from "@/lib/customer/shadow-verdict/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ entityId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const role = getRoleForEmail(session.user.email);
  if (!isManagerOrAdmin(role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { entityId } = await ctx.params;
  const history = await getEntityVerdictHistory(entityId, 28);
  return NextResponse.json(
    { entity_id: entityId, history },
    { headers: { "Cache-Control": "no-store" } },
  );
}
