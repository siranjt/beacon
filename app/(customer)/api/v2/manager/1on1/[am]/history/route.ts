import { NextRequest, NextResponse } from "next/server";
import { readOneOnOneHistory } from "@/lib/customer/one-on-one";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteCtx = { params: { am: string } };

/**
 * GET /api/v2/manager/1on1/[am]/history?limit=20
 *
 * Returns the most recent N 1:1 log rows for this AM (held_at DESC).
 *
 * Phase 33.B — admin + manager only.
 */
export async function GET(req: NextRequest, ctx: RouteCtx) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const amName = decodeURIComponent(ctx.params.am || "");
  if (!amName) {
    return NextResponse.json(
      { ok: false, error: "Missing AM name" },
      { status: 400 },
    );
  }
  const limitParam = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, 100)
    : 20;
  try {
    const rows = await readOneOnOneHistory(amName, limit);
    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg, rows: [] }, { status: 500 });
  }
}
