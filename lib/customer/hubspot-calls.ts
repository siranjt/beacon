/**
 * Fetch HubSpot call engagement counts per company for the last 30 days.
 *
 * Phase 14.4: hybrid approach. Confirmed from prod logs that the v3
 * Search API does NOT return the `associations` field in the response
 * (even when requested), so Phase 14.3's search-based attribution
 * returned 0 calls despite finding 10K recent ones. We now combine:
 *
 *   1. Associations API — company → call_id map (fast; 43K mappings).
 *   2. Inverse map — call_id → Set<company_id>.
 *   3. Search API — filter calls by hs_timestamp >= cutoff (no IN
 *      filter, no associations requested) → ~10K recent IDs.
 *   4. Cross-reference each recent call ID against the inverse map.
 *   5. Aggregate per company.
 *
 * Returns per-company { call_count_30d, last_call_at } so the compose
 * stage can compare HubSpot's logged calls against Metabase's phone CSV
 * and surface a "comms drift" hygiene flag.
 *
 * Either step failing (associations or search) yields an empty Map —
 * Stage D must not crash because an optional fetch failed.
 */

import { hubspotSearchAll, hubspotBatchAssociations, hubspotConfigured } from "./hubspot";

export type CallsForCompany = {
  call_count_30d: number;
  last_call_at: string | null;
};

const CALL_PROPS = ["hs_timestamp", "hs_call_duration", "hs_call_direction"];

export async function fetchCallsForCompanies(
  hubspotCompanyIds: string[],
): Promise<Map<string, CallsForCompany>> {
  const out = new Map<string, CallsForCompany>();
  if (!hubspotConfigured() || !hubspotCompanyIds.length) return out;

  // Step 1: company → call_ids associations (~43K mappings, returns fast)
  let companyToCallIds: Map<string, number[]>;
  try {
    companyToCallIds = await hubspotBatchAssociations(
      "companies",
      hubspotCompanyIds,
      "calls",
    );
  } catch (e) {
    console.warn("[hubspot-calls] associations fetch failed:", e instanceof Error ? e.message : String(e));
    return out;
  }

  if (companyToCallIds.size === 0) {
    console.log("[hubspot-calls] no company-call associations found");
    return out;
  }

  console.log(`[hubspot-calls] step 1: ${companyToCallIds.size}/${hubspotCompanyIds.length} companies have call associations`);

  // Step 2: build inverse map call_id → Set<company_id>
  const callToCompanies = new Map<string, Set<string>>();
  for (const [companyId, callIds] of companyToCallIds) {
    for (const cid of callIds) {
      const key = String(cid);
      let companies = callToCompanies.get(key);
      if (!companies) {
        companies = new Set<string>();
        callToCompanies.set(key, companies);
      }
      companies.add(companyId);
    }
  }
  console.log(`[hubspot-calls] step 2: built inverse map for ${callToCompanies.size} unique call IDs`);

  // Step 3: search recent calls (timestamp >= cutoff)
  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let recentCalls: Array<{ id: string; properties: Record<string, string> }>;
  try {
    recentCalls = await hubspotSearchAll<{
      id: string;
      properties: Record<string, string>;
    }>("calls", {
      filterGroups: [
        {
          filters: [
            { propertyName: "hs_timestamp", operator: "GTE", value: String(cutoffMs) },
          ],
        },
      ],
      properties: CALL_PROPS,
    });
  } catch (e) {
    console.warn("[hubspot-calls] search failed:", e instanceof Error ? e.message : String(e));
    return out;
  }
  console.log(`[hubspot-calls] step 3: ${recentCalls.length} calls in last 30d`);

  // Step 4 + 5: cross-reference and aggregate
  let attributedCount = 0;
  for (const call of recentCalls) {
    const companies = callToCompanies.get(call.id);
    if (!companies || companies.size === 0) continue; // Not associated with any tracked company

    const tsRaw = call.properties.hs_timestamp || "";
    let tsMs = Number(tsRaw);
    if (!Number.isFinite(tsMs) || tsMs <= 0) {
      // Try parsing as ISO date string
      tsMs = Date.parse(tsRaw);
    }
    if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;

    const tsIso = new Date(tsMs).toISOString();
    for (const companyId of companies) {
      attributedCount += 1;
      const existing = out.get(companyId);
      if (existing) {
        existing.call_count_30d += 1;
        const existingMs = existing.last_call_at ? Date.parse(existing.last_call_at) : 0;
        if (tsMs > existingMs) existing.last_call_at = tsIso;
      } else {
        out.set(companyId, { call_count_30d: 1, last_call_at: tsIso });
      }
    }
  }
  console.log(`[hubspot-calls] step 4: attributed ${attributedCount} calls to ${out.size}/${hubspotCompanyIds.length} companies`);
  return out;
}
