import { NextRequest, NextResponse } from "next/server";
import { listPinned, togglePinned } from "@/lib/customer/pinned-customers";
import { getApiUser, requireAmScope, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * GET /api/v2/pinned?am=<am_name>
 *   → { ok: true, pinned: PinnedCustomer[] }
 *
 * Returns all pinned customers for the given AM, most recent first.
 *
 * Phase 33.B — admin + manager bypass; AMs forced to their own am_name.
 */
export async function GET(req: NextRequest) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  let am = req.nextUrl.searchParams.get("am");
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
    const rows = await listPinned(am);
    return NextResponse.json({ ok: true, pinned: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

type PinnedBody = {
  am?: string;
  entity_id?: string;
  customer_id?: string;
  bizname?: string;
};

/**
 * POST /api/v2/pinned
 *   body: { am: string; entity_id: string; customer_id?: string; bizname?: string }
 *   → { ok: true, pinned: boolean }
 *
 * Toggles the pin state for (am, entity_id). Returns the new state.
 *
 * Phase 33.B — admin + manager bypass; AMs scoped to their own am_name.
 */
export async function POST(req: NextRequest) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  let body: PinnedBody | null = null;
  try {
    body = (await req.json()) as PinnedBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const { am, entity_id, customer_id, bizname } = body || {};
  if (!am || !entity_id) {
    return NextResponse.json(
      { ok: false, error: "Missing am or entity_id" },
      { status: 400 },
    );
  }

  const scopeDenied = requireAmScope(user, am);
  if (scopeDenied) return scopeDenied;

  try {
    const result = await togglePinned(am, entity_id, {
      customer_id: customer_id ?? null,
      bizname: bizname ?? null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
