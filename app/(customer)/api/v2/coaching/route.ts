import { NextResponse } from "next/server";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { getCoachingPerAm, type CoachingRow } from "@/lib/customer/coaching";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 27 — Coaching loops rollup.
 *
 * GET /api/v2/coaching          → rows for every AM (admin + manager)
 * GET /api/v2/coaching?am=Foo   → single-element rows array filtered to Foo
 *
 * Response: { ok, generatedAt, rows: CoachingRow[] }.
 * Empty rows array is the expected response when there's no snapshot or DB
 * yet — the UI renders a friendly empty state in that case, NOT an error.
 *
 * Phase 33.B — scope rules:
 *   - admin + manager: see all AMs by default; ?am=X narrows.
 *   - am: forced to ?am=user.am_name. If they pass ?am=other → 403.
 */
export async function GET(req: Request) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;

  const url = new URL(req.url);
  const amFilter = url.searchParams.get("am");

  // Phase 33.B — AM-role scope enforcement.
  if (user && user.role === "am") {
    if (!user.am_name) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Your account isn't mapped to an AM in BaseSheet yet — contact your manager",
          rows: [] as CoachingRow[],
        },
        { status: 403 },
      );
    }
    if (amFilter && amFilter !== user.am_name) {
      return NextResponse.json(
        { ok: false, error: "Forbidden: this AM is not in your scope", rows: [] as CoachingRow[] },
        { status: 403 },
      );
    }
  }

  const effectiveAm =
    user && user.role === "am" ? user.am_name : amFilter;

  try {
    const snapshot = await readLatestSnapshotV2();
    if (!snapshot) {
      return NextResponse.json({
        ok: true,
        generatedAt: new Date().toISOString(),
        rows: [] as CoachingRow[],
      });
    }
    const allRows = await getCoachingPerAm(snapshot);
    const rows = effectiveAm
      ? allRows.filter((r) => r.am_name === effectiveAm)
      : allRows;
    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      rows,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg, rows: [] as CoachingRow[] },
      { status: 500 },
    );
  }
}
