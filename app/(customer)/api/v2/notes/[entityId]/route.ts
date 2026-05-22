import { NextRequest, NextResponse } from "next/server";
import { getNote, upsertNote } from "@/lib/customer/customer-notes";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { getApiUser, requireAmScope, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

type Ctx = { params: { entityId: string } };

/**
 * GET /api/v2/notes/:entityId?am=<am_name>
 *   → { ok: true, note: string, updated_at: string | null }
 *
 * Returns the saved note for (am, entityId), or empty string if none.
 *
 * Phase 33.B — admin + manager bypass; AMs scoped to customers in their book
 * (looked up via snapshot.am_name on entityId).
 */
export async function GET(req: NextRequest, ctx: Ctx) {
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
  const { entityId } = ctx.params;
  if (!entityId) {
    return NextResponse.json(
      { ok: false, error: "Missing entityId" },
      { status: 400 },
    );
  }

  // For AMs, verify the entity is in their book via snapshot lookup.
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
    try {
      const snap = await readLatestSnapshotV2();
      if (!snap) {
        return NextResponse.json(
          { ok: false, error: "No snapshot available yet" },
          { status: 503 },
        );
      }
      const customer = snap.customers.find((c) => c.entity_id === entityId);
      if (!customer) {
        return NextResponse.json(
          { ok: false, error: "Customer not found in latest snapshot" },
          { status: 404 },
        );
      }
      const scopeDenied = requireAmScope(user, customer.am_name);
      if (scopeDenied) return scopeDenied;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        { ok: false, error: `Snapshot read failed: ${msg}` },
        { status: 503 },
      );
    }
  }

  try {
    const note = await getNote(am, entityId);
    return NextResponse.json({
      ok: true,
      note: note?.note ?? "",
      updated_at: note?.updated_at ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * PUT /api/v2/notes/:entityId
 *   body: { am: string; note: string; customer_id?: string; bizname?: string }
 *   → { ok: true, note: string, updated_at: string }
 *
 * Upserts the note for (am, entityId).
 *
 * Phase 33.B — admin + manager bypass; AMs scoped to customers in their book.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  const { entityId } = ctx.params;
  if (!entityId) {
    return NextResponse.json(
      { ok: false, error: "Missing entityId" },
      { status: 400 },
    );
  }
  let body: {
    am?: string;
    note?: unknown;
    customer_id?: string | null;
    bizname?: string | null;
  } | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const { am, note, customer_id, bizname } = body || {};
  if (!am) {
    return NextResponse.json(
      { ok: false, error: "Missing am" },
      { status: 400 },
    );
  }
  if (typeof note !== "string") {
    return NextResponse.json(
      { ok: false, error: "Missing or invalid note" },
      { status: 400 },
    );
  }

  // AM-scope: confirm the entityId's owner_am matches user.am_name.
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
    try {
      const snap = await readLatestSnapshotV2();
      if (!snap) {
        return NextResponse.json(
          { ok: false, error: "No snapshot available yet" },
          { status: 503 },
        );
      }
      const customer = snap.customers.find((c) => c.entity_id === entityId);
      if (!customer) {
        return NextResponse.json(
          { ok: false, error: "Customer not found in latest snapshot" },
          { status: 404 },
        );
      }
      const scopeDenied = requireAmScope(user, customer.am_name);
      if (scopeDenied) return scopeDenied;
      // Also enforce body.am matches the user's am_name to keep writes honest.
      if (am !== user.am_name) {
        return NextResponse.json(
          { ok: false, error: "Forbidden: body.am does not match your AM" },
          { status: 403 },
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        { ok: false, error: `Snapshot read failed: ${msg}` },
        { status: 503 },
      );
    }
  }

  try {
    const saved = await upsertNote(am, entityId, note, {
      customer_id: customer_id ?? null,
      bizname: bizname ?? null,
    });
    return NextResponse.json({
      ok: true,
      note: saved.note,
      updated_at: saved.updated_at,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
