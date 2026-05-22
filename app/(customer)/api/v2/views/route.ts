import { NextRequest, NextResponse } from "next/server";
import { listViews, createView } from "@/lib/customer/saved-views";
import { getApiUser, requireAmScope, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * GET /api/v2/views?am=<am_name>
 *   → { ok: true, views: SavedView[] }
 *
 * Lists saved filter/search/sort views for an AM.
 *
 * Phase 33.B — any signed-in role. AMs scoped to their own am_name; admin
 * + manager may pass any am_name.
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
    const views = await listViews(am);
    return NextResponse.json({ ok: true, views });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

type CreateBody = {
  am?: string;
  name?: string;
  filter_config?: Record<string, unknown>;
};

/**
 * POST /api/v2/views
 *   body: { am: string; name: string; filter_config: object }
 *   → { ok: true, view: SavedView }
 *   → 409 { ok: false, error } if (am, name) already exists.
 *
 * Creates a new saved view. Names are unique per AM.
 *
 * Phase 33.B — AMs scoped to their own am_name; admin + manager may create
 * for any AM (used by managers preparing canned views).
 */
export async function POST(req: NextRequest) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  let body: CreateBody | null = null;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const { am, name, filter_config } = body || {};
  if (!am || typeof am !== "string") {
    return NextResponse.json(
      { ok: false, error: "Missing am" },
      { status: 400 },
    );
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json(
      { ok: false, error: "Missing or empty name" },
      { status: 400 },
    );
  }
  if (!filter_config || typeof filter_config !== "object") {
    return NextResponse.json(
      { ok: false, error: "Missing filter_config" },
      { status: 400 },
    );
  }

  const scopeDenied = requireAmScope(user, am);
  if (scopeDenied) return scopeDenied;

  try {
    const result = await createView(am, name.trim(), filter_config);
    if (result.ok) {
      return NextResponse.json({ ok: true, view: result.view });
    }
    if ("conflict" in result && result.conflict) {
      return NextResponse.json(
        { ok: false, error: "A view with this name already exists" },
        { status: 409 },
      );
    }
    const errMsg = "error" in result ? result.error : "Unknown error";
    return NextResponse.json(
      { ok: false, error: errMsg },
      { status: 500 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
