/**
 * Fetch deals associated with a list of HubSpot companies.
 *
 * Returns per-company aggregates:
 *   - open_deal_count + open_deal_stages + total_open_amount
 *
 * Pulls last 180 days of deals to bound the query. Active customers
 * typically have <5 deals each.
 */

import { hubspotSearchAll, hubspotBatchAssociations, hubspotConfigured } from "./hubspot";

export type DealsForCompany = {
  open_deal_count: number;
  open_deal_stages: string[];
  total_open_amount: number;
  last_won_at: string | null;
};

type HubspotApiDeal = {
  id: string;
  properties: Record<string, string>;
};

const DEAL_PROPS = [
  "dealname",
  "dealstage",
  "amount",
  "closedate",
  "createdate",
  "pipeline",
  "hs_is_closed",
  "hs_is_closed_won",
  "hs_is_closed_lost",
  "hs_lastmodifieddate",
];

/**
 * For each HubSpot company_id, returns the aggregated deal info.
 * companies that have no deals return undefined (not in the map).
 */
export async function fetchDealsForCompanies(
  hubspotCompanyIds: string[],
): Promise<Map<string, DealsForCompany>> {
  const out = new Map<string, DealsForCompany>();
  if (!hubspotConfigured() || !hubspotCompanyIds.length) return out;

  // 1) Get deal associations (company → deal_ids)
  const companyToDealIds = await hubspotBatchAssociations(
    "companies",
    hubspotCompanyIds,
    "deals",
  );
  if (companyToDealIds.size === 0) return out;

  // Collect all unique deal IDs across all companies
  const allDealIds = new Set<number>();
  for (const ids of companyToDealIds.values()) {
    for (const id of ids) allDealIds.add(id);
  }
  if (allDealIds.size === 0) return out;

  // 2) Fetch deal records — use search to filter to last 180 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 180);
  const cutoffMs = cutoff.getTime();

  // Batch search through deals by ID (search supports up to 200 per call;
  // use IN operator with batches of 100)
  const dealRecords = new Map<string, HubspotApiDeal>();
  const dealIdsArr = Array.from(allDealIds);
  const CHUNK = 100;
  for (let i = 0; i < dealIdsArr.length; i += CHUNK) {
    const chunk = dealIdsArr.slice(i, i + CHUNK);
    const results = await hubspotSearchAll<HubspotApiDeal>("deals", {
      filterGroups: [
        {
          filters: [
            { propertyName: "hs_object_id", operator: "IN", values: chunk.map(String) },
          ],
        },
      ],
      properties: DEAL_PROPS,
    });
    for (const d of results) dealRecords.set(d.id, d);
  }

  // 3) Aggregate per company
  for (const [companyId, dealIds] of companyToDealIds) {
    let openCount = 0;
    const openStages = new Set<string>();
    let totalOpenAmount = 0;
    let lastWonAt: string | null = null;
    let lastWonMs = 0;

    for (const dealId of dealIds) {
      const d = dealRecords.get(String(dealId));
      if (!d) continue;
      const p = d.properties || {};
      const isClosed = (p.hs_is_closed || "").toLowerCase() === "true";
      const isWon = (p.hs_is_closed_won || "").toLowerCase() === "true";
      const amount = Number(p.amount || 0);
      const closeDateMs = p.closedate ? Date.parse(p.closedate) : 0;

      if (!isClosed) {
        openCount += 1;
        if (p.dealstage) openStages.add(p.dealstage);
        if (Number.isFinite(amount)) totalOpenAmount += amount;
      } else if (isWon && closeDateMs >= cutoffMs) {
        if (closeDateMs > lastWonMs) {
          lastWonMs = closeDateMs;
          lastWonAt = p.closedate || null;
        }
      }
    }

    if (openCount > 0 || lastWonAt) {
      out.set(companyId, {
        open_deal_count: openCount,
        open_deal_stages: Array.from(openStages),
        total_open_amount: Math.round(totalOpenAmount),
        last_won_at: lastWonAt,
      });
    }
  }

  console.log(
    `[hubspot-deals] fetched deals for ${out.size}/${hubspotCompanyIds.length} companies (${dealRecords.size} deals total)`,
  );
  return out;
}
