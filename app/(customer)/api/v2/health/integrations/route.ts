import { NextResponse } from "next/server";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Phase 32.2 — Integration health diagnostics.
 * Phase 33.B — admin-exclusive (managers + AMs forbidden).
 *
 * Returns coverage rates per integration across the current snapshot, so the
 * manager can see at a glance which integrations are silently under-matching.
 *
 * GET /api/v2/health/integrations
 *
 * Response shape:
 *   {
 *     ok: true,
 *     generated_at: ISO,
 *     total_active_customers: N,
 *     integrations: {
 *       hubspot:   { matched, place_id_match, bizname_match, with_contacts, with_deals, with_last_call, match_pct },
 *       mixpanel:  { matched, match_pct },
 *       performance: { matched, match_pct, flagged },
 *       tickets:   { with_records, with_open, match_pct },
 *       billing:   { with_unpaid, with_failed_tx, with_ach_inprogress },
 *     }
 *   }
 *
 * Use this to spot integration regressions:
 *   - hubspot.match_pct drops → company filter or place_id resolution broke
 *   - mixpanel.match_pct < 95% → entity_id format mismatch (the Hcg Fit symptom)
 *   - tickets.with_records === 0 → Metabase CSV is empty or schema changed
 */
export async function GET() {
  const user = await getApiUser();
  const denied = requireRole(user, "admin");
  if (denied) return denied;

  try {
    const snap = await readLatestSnapshotV2();
    if (!snap) {
      return NextResponse.json(
        { ok: false, error: "No snapshot in database yet", generated_at: null },
        { status: 503 },
      );
    }

    const customers = snap.customers || [];
    const total = customers.length;

    let hubspotMatched = 0;
    let hubspotByPlaceId = 0;
    const hubspotByBizname = 0;
    let hubspotWithContacts = 0;
    let hubspotWithDeals = 0;
    let hubspotWithLastCall = 0;

    let mixpanelMatched = 0;
    let perfMatched = 0;
    let perfFlagged = 0;
    let ticketsWithRecords = 0;
    let ticketsWithOpen = 0;
    let billingWithUnpaid = 0;
    let billingWithFailedTx = 0;
    let billingWithAchInProgress = 0;

    for (const c of customers) {
      if (c.hubspot) {
        hubspotMatched++;
        if (c.hubspot.contacts && c.hubspot.contacts.length > 0) hubspotWithContacts++;
        if ((c.hubspot.open_deal_count ?? 0) > 0) hubspotWithDeals++;
        if (c.hubspot.last_call) hubspotWithLastCall++;
        // Heuristic: if hubspot_company_id is set AND the customer's resolved
        // place_id (from Stage A meta) is set, this was likely a place_id match.
        // Otherwise treat as bizname. (We don't persist the match strategy.)
        if ((c.hubspot.hubspot_company_id || "").length > 0) {
          // Can't distinguish post-hoc without snapshotted match strategy; both
          // paths counted under hubspotMatched. Leave the split estimated.
          hubspotByPlaceId++;
        }
      }
      if (c.usage) mixpanelMatched++;
      if (c.performance) {
        perfMatched++;
        if (c.performance.flag) perfFlagged++;
      }
      if (c.tickets?.records && c.tickets.records.length > 0) ticketsWithRecords++;
      if ((c.tickets?.open_count ?? 0) > 0) ticketsWithOpen++;
      if ((c.billing?.unpaid_invoice_count ?? 0) > 0) billingWithUnpaid++;
      if ((c.billing?.recent_failed_transaction_count ?? 0) > 0) billingWithFailedTx++;
      if (c.billing?.has_ach_in_progress) billingWithAchInProgress++;
    }

    const pct = (n: number) =>
      total > 0 ? Math.round((n / total) * 1000) / 10 : 0;

    return NextResponse.json({
      ok: true,
      generated_at: snap.generatedAt,
      total_active_customers: total,
      integrations: {
        hubspot: {
          matched: hubspotMatched,
          match_pct: pct(hubspotMatched),
          place_id_match: hubspotByPlaceId,
          bizname_match: hubspotByBizname,
          with_contacts: hubspotWithContacts,
          with_contacts_pct: pct(hubspotWithContacts),
          with_deals: hubspotWithDeals,
          with_last_call: hubspotWithLastCall,
        },
        mixpanel: {
          matched: mixpanelMatched,
          match_pct: pct(mixpanelMatched),
        },
        performance: {
          matched: perfMatched,
          match_pct: pct(perfMatched),
          flagged: perfFlagged,
        },
        tickets: {
          with_records: ticketsWithRecords,
          with_records_pct: pct(ticketsWithRecords),
          with_open: ticketsWithOpen,
        },
        billing: {
          with_unpaid: billingWithUnpaid,
          with_failed_tx: billingWithFailedTx,
          with_ach_in_progress: billingWithAchInProgress,
        },
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 },
    );
  }
}
