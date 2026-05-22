import { NextRequest, NextResponse } from "next/server";
import { writeAmAction } from "@/lib/customer/postgres";
import type { AmActionType, ContactReasonCode } from "@/lib/customer/types";
import { getApiUser, requireAmScope, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ContactedBody = {
  am_name?: string;
  entity_id?: string;
  action_type?: string;
  note?: string;
  composite_at_action?: number;
  reason_code?: string;
  follow_up_date?: string;
};

/**
 * POST /api/v2/actions/contacted
 * body: {
 *   am_name: string;
 *   entity_id: string;
 *   action_type: "contacted_connected" | "contacted_vm" | "contacted_noreach";
 *   note?: string;
 *   composite_at_action?: number;
 * }
 *   → logs an AM action. Returns the new row id.
 *     Powers the one-click "Mark contacted" flow on each customer card.
 *
 * Phase 33.B — admin + manager bypass; AMs may only log against their own
 * am_name. Scope check uses body.am_name.
 */
export async function POST(req: NextRequest) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  let body: ContactedBody | null = null;
  try {
    body = (await req.json()) as ContactedBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const {
    am_name,
    entity_id,
    action_type,
    note,
    composite_at_action,
    reason_code,
    follow_up_date,
  } = body || {};
  if (!am_name || !entity_id || !action_type) {
    return NextResponse.json(
      { error: "am_name, entity_id, action_type required" },
      { status: 400 },
    );
  }

  // Phase 33.B — AM-scope enforcement using body.am_name.
  const scopeDenied = requireAmScope(user, am_name);
  if (scopeDenied) return scopeDenied;

  if (!["contacted_connected", "contacted_vm", "contacted_noreach"].includes(action_type)) {
    return NextResponse.json(
      { error: "action_type must be one of contacted_connected/contacted_vm/contacted_noreach" },
      { status: 400 },
    );
  }
  const VALID_REASONS = ["renewal", "performance", "billing", "complaint", "check_in", "onboarding", "other"];
  if (reason_code && !VALID_REASONS.includes(reason_code)) {
    return NextResponse.json(
      { error: `reason_code must be one of ${VALID_REASONS.join("/")}` },
      { status: 400 },
    );
  }
  if (follow_up_date && !/^\d{4}-\d{2}-\d{2}$/.test(follow_up_date)) {
    return NextResponse.json(
      { error: "follow_up_date must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  // Phase 33.B.3 — narrow action_type + reason_code from validated strings
  // to their actual union types. TypeScript doesn't infer through .includes()
  // runtime checks, so we cast after the validation gates above.
  const validatedActionType = action_type as AmActionType;
  const validatedReasonCode = (reason_code ?? null) as ContactReasonCode | null;
  try {
    const id = await writeAmAction({
      am_name,
      entity_id,
      action_type: validatedActionType,
      note: note ?? null,
      composite_at_action: composite_at_action ?? null,
      reason_code: validatedReasonCode,
      follow_up_date: follow_up_date ?? null,
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
