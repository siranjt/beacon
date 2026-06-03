import { NextRequest, NextResponse } from "next/server";
import {
  clearCallOutcome,
  markCallOutcome,
  type CallOutcomeKind,
} from "@/lib/customer/call-outcomes";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { logUmbrellaActivity } from "@/lib/activity/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const VALID_OUTCOMES: ReadonlySet<CallOutcomeKind> = new Set([
  "connected",
  "vm",
  "not_connected",
]);

type Body = { outcome?: string };

/**
 * POST /api/v2/customer/<entityId>/call-outcome
 *   body: { outcome: 'connected' | 'vm' | 'not_connected' }
 *   → { ok: true, outcome: CallOutcomeRow }
 *
 * Records the AM's call outcome. Auto-expires after 7 days. Re-posting
 * REPLACES the existing row and resets the timer. Anyone with admin / manager
 * / am role can mark — the outcome is global per entity (every AM looking at
 * the card sees the same pill), but the marker's email is recorded.
 *
 * 'connected' also demotes the customer out of the "needs a call" bucket for
 * the 7-day window — see lib/customer/call-outcomes.ts applyOutcomeOverride.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ entityId: string }> },
) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401 });
  }

  const { entityId } = await params;
  if (!entityId) {
    return NextResponse.json(
      { ok: false, error: "Missing entityId" },
      { status: 400 },
    );
  }

  let body: Body | null = null;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const outcomeStr = String(body?.outcome || "").toLowerCase().trim();
  if (!VALID_OUTCOMES.has(outcomeStr as CallOutcomeKind)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Invalid outcome — must be one of: ${Array.from(VALID_OUTCOMES).join(", ")}`,
      },
      { status: 400 },
    );
  }

  try {
    const row = await markCallOutcome({
      entityId,
      outcome: outcomeStr as CallOutcomeKind,
      markedByEmail: user.email,
      markedByName: user.am_name,
    });

    // Fire-and-forget audit row.
    void logUmbrellaActivity({
      email: user.email,
      role: user.role,
      am_name: user.am_name,
      agent: "customer",
      event_name: "call_outcome:marked",
      surface: "v2-card",
      entity_id: entityId,
      metadata: {
        outcome: row.outcome,
        expires_at: row.expires_at,
      },
    });

    return NextResponse.json({ ok: true, outcome: row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * DELETE /api/v2/customer/<entityId>/call-outcome
 *   → { ok: true }
 *
 * Clears the active outcome (idempotent). Useful for "I marked the wrong
 * customer — undo" or for manager review.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ entityId: string }> },
) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401 });
  }

  const { entityId } = await params;
  if (!entityId) {
    return NextResponse.json(
      { ok: false, error: "Missing entityId" },
      { status: 400 },
    );
  }

  try {
    await clearCallOutcome(entityId);
    void logUmbrellaActivity({
      email: user.email,
      role: user.role,
      am_name: user.am_name,
      agent: "customer",
      event_name: "call_outcome:cleared",
      surface: "v2-card",
      entity_id: entityId,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
