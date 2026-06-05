import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { listCandidates, getSourceQuoteForFact } from "@/lib/brain/repo";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import type { BrainFact } from "@/lib/brain/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface HydratedCandidate extends BrainFact {
  bizname: string | null;
  entity_id: string | null;
  am_name_resolved: string | null;
  source_quote: string | null;
}

/**
 * GET /api/v2/brain/validate
 *
 *   List candidate facts (confidence_state='candidate', not deleted)
 *   awaiting AM/manager review. Hydrates each row with bizname +
 *   entity_id + resolved am_name from the latest snapshot, plus the
 *   verbatim source_quote from the version log.
 *
 *   Query params:
 *     - limit (default 200, max 500)
 *     - offset (default 0)
 *     - mine (=1 → restrict to candidates whose owning_am_email matches
 *       the caller; ignored for managers viewing the full inbox)
 *
 *   Auth: AM + manager + admin. AMs see only their book; managers see all.
 *
 *   Response:
 *     {
 *       ok, total, returned, offset,
 *       rows: [
 *         {fact_id, customer_id, entity_id, bizname, am_name_resolved,
 *          topic_category, topic_subcategory, field_name, value,
 *          source_type, source_ref, source_quote, owning_am_email,
 *          created_at, current_version, ...}
 *       ],
 *       grouped_by_am: { "AM Name": [rows...] }
 *     }
 */
export async function GET(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;

  const url = new URL(req.url);
  const limit = Math.max(
    1,
    Math.min(500, Number(url.searchParams.get("limit") || 200)),
  );
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const mine = url.searchParams.get("mine") === "1";

  // For AMs (or anyone passing mine=1), restrict by their email. Managers
  // viewing the full inbox skip the filter.
  let owningAmEmails: string[] | undefined;
  if (user?.role === "am" || mine) {
    if (!user?.email) return NextResponse.json({ ok: false, error: "no email" }, { status: 401 });
    owningAmEmails = [user.email];
  }

  const { rows, total } = await listCandidates({
    owning_am_emails: owningAmEmails,
    limit,
    offset,
  });

  // Hydrate from snapshot (customer_id → entity_id + bizname + am_name).
  const snap = await readLatestSnapshotV2();
  type SnapCustomer = {
    customer_id?: string | null;
    entity_id?: string | null;
    company?: string | null;
    am_name?: string | null;
  };
  const byCustomerId = new Map<string, SnapCustomer>();
  for (const c of (snap?.customers ?? []) as SnapCustomer[]) {
    if (c.customer_id) byCustomerId.set(c.customer_id, c);
  }

  const hydrated: HydratedCandidate[] = [];
  for (const r of rows) {
    const snapCust = byCustomerId.get(r.customer_id) ?? null;
    const quote = await getSourceQuoteForFact(r.fact_id);
    hydrated.push({
      ...r,
      bizname: snapCust?.company ?? null,
      entity_id: snapCust?.entity_id ?? null,
      am_name_resolved: snapCust?.am_name ?? null,
      source_quote: quote,
    });
  }

  // Group by AM (resolved name; falls back to "Unassigned" when null).
  const groupedByAm: Record<string, HydratedCandidate[]> = {};
  for (const r of hydrated) {
    const key = r.am_name_resolved || "Unassigned";
    if (!groupedByAm[key]) groupedByAm[key] = [];
    groupedByAm[key].push(r);
  }

  return NextResponse.json(
    {
      ok: true,
      total,
      returned: hydrated.length,
      offset,
      rows: hydrated,
      grouped_by_am: groupedByAm,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
