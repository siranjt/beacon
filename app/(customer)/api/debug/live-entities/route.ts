// Phase E-19.1a — live active-entity diagnostic endpoint.
//
// Returns the current authoritative set of active entity_ids derived from
// Chargebee subscription cf_entity_id (the exact same logic Stage B uses to
// build the active customer universe). This is the canonical answer to
// "who's a live Beacon customer right now".
//
// Use cases:
//   - Scale-test driver for bulk-comms-events Metabase question (E-19.1)
//   - Parity harness inputs (E-19.2 cutover validation)
//   - Ops scripts that need the live set without re-running Chargebee
//   - Sanity check after Stage A — does the snapshot count match Chargebee
//     truth right now?
//
// Returns:
//   {
//     entity_ids: string[],                    // sorted, deduped
//     comma_separated: string,                 // ready to paste into Metabase
//     count: number,
//     meta: {
//       totalSubs: number,
//       statusBreakdown: { active, non_renewing, in_trial, future },
//       subsWithoutEntity: [{customer_id, subscription_id, status}],  // ops data hole
//       uniqueCustomers: number,
//       multiEntityCustomers: number,
//     },
//   }
//
// Manager+admin only. Not cached (the whole point is live truth).

import { NextResponse } from "next/server";
import { fetchLiveActiveEntityIds } from "@/lib/customer/chargebee";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const t0 = Date.now();
  try {
    const { entityIds, meta } = await fetchLiveActiveEntityIds();
    const elapsed_ms = Date.now() - t0;
    return NextResponse.json({
      ok: true,
      count: entityIds.length,
      entity_ids: entityIds,
      comma_separated: entityIds.join(","),
      meta,
      elapsed_ms,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: message, elapsed_ms: Date.now() - t0 },
      { status: 500 },
    );
  }
}
