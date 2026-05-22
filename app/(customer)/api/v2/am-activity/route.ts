import { NextResponse } from "next/server";
import { getAmOutcomeStats } from "@/lib/customer/postgres";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 15.2 — per-AM action + outcome rollup for the manager dashboard.
 * Phase 33.B — admin + manager only (Manager view feature).
 *
 * Query: ?days=7 (default 7, max 90)
 * Returns: { ok, daysBack, generatedAt, rows: AmOutcomeStats[] }
 *
 * Empty array (rows: []) is the expected response when no actions exist yet,
 * not an error. The UI renders an empty-state in that case.
 */
export async function GET(req: Request) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const url = new URL(req.url);
  const daysParam = Number(url.searchParams.get("days"));
  const daysBack = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 90) : 7;
  try {
    const rows = await getAmOutcomeStats(daysBack);
    return NextResponse.json({
      ok: true,
      daysBack,
      generatedAt: new Date().toISOString(),
      rows,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg, rows: [] }, { status: 500 });
  }
}
