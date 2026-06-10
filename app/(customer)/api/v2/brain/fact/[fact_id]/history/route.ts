import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { getFactHistory } from "@/lib/brain/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/brain/fact/[fact_id]/history
 *
 *   Read the append-only version log for a single Keeper fact. Used by
 *   V2BrainPanel's "view history" affordance (Wave 2c.1) to expand the
 *   timeline of edits / confirmations / refines under a fact row.
 *
 *   AM + manager + admin allowed. The version log is non-sensitive
 *   per-customer metadata; gating to authenticated team members is
 *   sufficient.
 *
 *   Response:
 *     { ok: true, fact_id, versions: BrainFactVersion[] }   // newest first
 *
 *   Returns an empty `versions` array when the fact has no history rows
 *   (shouldn't happen in practice — every fact has at least a `create`
 *   row — but we surface a 200 with [] rather than 404 so the UI can
 *   render a neutral empty state).
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ fact_id: string }> },
) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;

  const { fact_id } = await ctx.params;
  if (!fact_id) {
    return NextResponse.json(
      { ok: false, error: "fact_id required" },
      { status: 400 },
    );
  }

  try {
    const versions = await getFactHistory(fact_id);
    return NextResponse.json({ ok: true, fact_id, versions });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
