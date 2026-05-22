import { NextRequest, NextResponse } from "next/server";
import {
  listActiveSnoozes,
  snoozeCustomer,
  unsnoozeCustomer,
} from "@/lib/customer/snooze";
import { getApiUser, requireAmScope, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * GET /api/v2/snooze?am=<am_name>
 *   → { ok: true, snoozed: SnoozedCustomer[] }
 *
 * Returns currently active snoozes (snoozed_until > NOW) for the given AM,
 * sorted by expiry ascending.
 *
 * Phase 33.B — admin + manager bypass; AMs forced to their own am_name.
 * If an AM passes ?am=other → 403.
 */
export async function GET(req: NextRequest) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  let am = req.nextUrl.searchParams.get("am");
  // Phase 33.B — AMs forced to their own am_name. Managers/admins may pass
  // any am_name and see that AM's snoozes.
  if (user && user.role === "am") {
    if (!user.am_name) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Your account isn't mapped to an AM in BaseSheet yet — contact your manager",
        },
        { status: 403 },
      );
    }
    if (am && am !== user.am_name) {
      return NextResponse.json(
        { ok: false, error: "Forbidden: this AM is not in your scope" },
        { status: 403 },
      );
    }
    am = user.am_name;
  }

  if (!am) {
    return NextResponse.json(
      { ok: false, error: "Missing 'am' query param" },
      { status: 400 },
    );
  }
  try {
    const snoozed = await listActiveSnoozes(am);
    return NextResponse.json({ ok: true, snoozed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

type SnoozeBody = {
  am?: string;
  entity_id?: string;
  days?: number | string;
  customer_id?: string;
  bizname?: string;
  reason?: string;
};

/**
 * POST /api/v2/snooze
 *   body: { am: string; entity_id: string; days: number;
 *           customer_id?: string; bizname?: string; reason?: string }
 *   → { ok: true, snoozed: SnoozedCustomer }
 *
 * Upserts a snooze row. `days` is bounded to 1..365 to defend against
 * accidental clicks.
 *
 * Phase 33.B — admin + manager bypass; AMs scoped to their own am_name.
 */
export async function POST(req: NextRequest) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  let body: SnoozeBody | null = null;
  try {
    body = (await req.json()) as SnoozeBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const { am, entity_id, days, customer_id, bizname, reason } = body || {};
  if (!am || !entity_id) {
    return NextResponse.json(
      { ok: false, error: "Missing am or entity_id" },
      { status: 400 },
    );
  }

  const scopeDenied = requireAmScope(user, am);
  if (scopeDenied) return scopeDenied;

  const dayCount = Number(days);
  if (!Number.isFinite(dayCount) || dayCount <= 0 || dayCount > 365) {
    return NextResponse.json(
      { ok: false, error: "Invalid days (must be 1..365)" },
      { status: 400 },
    );
  }
  try {
    const snoozed = await snoozeCustomer(am, entity_id, dayCount, {
      customer_id: customer_id ?? null,
      bizname: bizname ?? null,
      reason: reason ?? null,
    });
    return NextResponse.json({ ok: true, snoozed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * DELETE /api/v2/snooze?am=<am>&entity_id=<entity_id>
 *   → { ok: true }
 *
 * Removes the snooze row for the (am, entity) pair. Idempotent.
 *
 * Phase 33.B — admin + manager bypass; AMs scoped to their own am_name.
 */
export async function DELETE(req: NextRequest) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  const am = req.nextUrl.searchParams.get("am");
  const entity_id = req.nextUrl.searchParams.get("entity_id");
  if (!am || !entity_id) {
    return NextResponse.json(
      { ok: false, error: "Missing am or entity_id" },
      { status: 400 },
    );
  }

  const scopeDenied = requireAmScope(user, am);
  if (scopeDenied) return scopeDenied;

  try {
    await unsnoozeCustomer(am, entity_id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
