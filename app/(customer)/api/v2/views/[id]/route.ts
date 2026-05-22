import { NextRequest, NextResponse } from "next/server";
import { deleteView } from "@/lib/customer/saved-views";
import { getApiUser, requireAmScope, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

type Ctx = { params: { id: string } };

/**
 * DELETE /api/v2/views/:id?am=<am_name>
 *   → { ok: true }
 *
 * Removes a saved view by (am, id). No-op if missing.
 *
 * Phase 33.B — admins bypass; managers may delete any AM's view; AMs may
 * only delete their own (their session am_name must match the ?am= param).
 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  const am = req.nextUrl.searchParams.get("am");
  if (!am) {
    return NextResponse.json(
      { ok: false, error: "Missing 'am' query param" },
      { status: 400 },
    );
  }
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid id" },
      { status: 400 },
    );
  }

  // Phase 33.B — owner match (or admin/manager). requireAmScope returns null
  // for admin + manager, and enforces user.am_name === am for role=am.
  const scopeDenied = requireAmScope(user, am);
  if (scopeDenied) return scopeDenied;

  try {
    await deleteView(am, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
