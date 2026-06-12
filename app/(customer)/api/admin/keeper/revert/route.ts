/**
 * WAVE-A-2 — Self-service supersede rollback endpoint.
 *
 *   POST /api/admin/keeper/revert
 *
 * Body: { factId: string, reason?: string }
 *
 *   factId — the CURRENTLY-AUTHORITATIVE Keeper fact whose elevation we want
 *            to undo. The route resolves its most-recent superseded ancestor
 *            and atomically flips the chain (loser ↔ winner) via
 *            revertSupersession(). See lib/brain/revert.ts for the mechanics.
 *
 *   reason — optional free-text reason stamped on the audit row + version
 *            log. Capped at 500 chars in revertSupersession().
 *
 * Status codes:
 *   200 — success; body: { ok, revertedFromFactId, revertedToFactId, customerId }
 *   400 — invalid body OR fact has no superseded ancestor to revert to
 *   404 — fact not found (or soft-deleted)
 *   401/403 — auth gates (re-used requireRole admin/manager only)
 *   500 — DB / transaction failure
 *
 * Auth: admin + manager only. AMs can confirm/reject candidates via the
 * existing /api/v2/brain/validate route, but a revert IS a manager-grade
 * action — it overrides the deterministic ranking-engine decision. Scope
 * stays tight on purpose; can open up to AM later if the ops team asks.
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { revertSupersession } from "@/lib/brain/revert";
import { logUmbrellaActivity } from "@/lib/activity/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RevertBody {
  factId?: unknown;
  reason?: unknown;
}

export async function POST(req: NextRequest) {
  const user = await getApiUser();
  // Admin + manager only — the revert overrides ranking-engine output, which
  // is too consequential for AMs to fire from the Validate inbox today.
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;
  if (!user?.email) {
    return NextResponse.json(
      { ok: false, error: "no email" },
      { status: 401 },
    );
  }

  let body: RevertBody;
  try {
    body = (await req.json()) as RevertBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }

  const factId = typeof body.factId === "string" ? body.factId.trim() : "";
  if (!factId) {
    return NextResponse.json(
      { ok: false, error: "factId required" },
      { status: 400 },
    );
  }

  const reason =
    typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : undefined;

  const result = await revertSupersession(factId, user.email, reason);

  if (!result.ok) {
    // Map error codes to HTTP status. "no_ancestor" is the documented 400
    // case — the user clicked Revert on a fact that has nothing to revert to.
    const status =
      result.error === "fact_not_found"
        ? 404
        : result.error === "no_ancestor" || result.error === "chain_broken"
          ? 400
          : 500;
    return NextResponse.json(
      { ok: false, error: result.error, message: result.message },
      { status },
    );
  }

  // Fire-and-forget audit ping into the umbrella activity log so the
  // /admin/activity-log view picks it up alongside the brain_candidate:*
  // events. Mirrors the pattern in the Validate inbox triage route.
  void logUmbrellaActivity({
    email: user.email,
    role: user.role,
    am_name: user.am_name ?? null,
    agent: "customer",
    event_name: "keeper:revert",
    surface: "admin",
    entity_id: null,
    metadata: {
      reverted_from_fact_id: result.revertedFromFactId,
      reverted_to_fact_id: result.revertedToFactId,
      customer_id: result.customerId,
      reason: reason ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    revertedFromFactId: result.revertedFromFactId,
    revertedToFactId: result.revertedToFactId,
    customerId: result.customerId,
  });
}
