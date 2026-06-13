/**
 * WAVE-B-3 — POST /api/keeper/questions/[id]/dismiss
 *
 * AM clicked the dismiss × on a keeper_questions strip card. Mark it
 * dismissed. Idempotent: re-dismissing an already-terminal row returns
 * `{ ok: true }` without surprise.
 *
 * Body (optional):
 *   { reason?: string }   // currently logged for telemetry only; the
 *                          // table doesn't yet carry a dismiss_reason
 *                          // column. Keeping the field on the API
 *                          // contract so a future migration can lift
 *                          // it without a client change.
 *
 * Responses:
 *   200 { ok: true }
 *   400 invalid id
 *   500 uncaught
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { markDismissed } from "@/lib/keeper/questions-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } },
) {
  try {
    const user = await getApiUser();
    const denied = requireRole(user, "admin", "manager", "am");
    if (denied) return denied;
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Not authenticated" },
        { status: 401 },
      );
    }

    const id = Number(ctx.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json(
        { ok: false, error: "invalid question id" },
        { status: 400 },
      );
    }

    // Drain the body for telemetry shape, but don't fail the request if
    // it's missing/malformed. The `reason` is currently informational
    // only — the schema has no dismiss_reason column yet.
    try {
      await req.json();
    } catch {
      /* no body is fine */
    }

    // markDismissed is idempotent — its UPDATE has WHERE status = 'pending',
    // so re-dismissing returns false but doesn't break anything. We
    // always return ok:true so the UI's optimistic remove can land
    // immediately.
    await markDismissed(id, user.email);

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[/api/keeper/questions/[id]/dismiss POST] uncaught:", msg);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 },
    );
  }
}
