// Phase E-19 W2.5 cleanup — V1 5-CSV comms helpers (fetchAllComms,
// fetchAllCommsSequential, groupCommsByEntity, CommsParseStats) deleted.
// Stage B now ingests via the bulk-events Metabase question (V2).
// This module retains only the BaseSheet fetcher + bizname normalizer.

import Papa from "papaparse";
import { METABASE_ENDPOINTS } from "./config";
import type { BaseSheetRow } from "./types";

async function fetchCsvText(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    cache: "no-store",
    // Metabase public CSV is stable; 60s revalidate is fine for cron retries
    headers: { Accept: "text/csv" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Metabase CSV ${url} ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.text();
}

function parseRows<T extends Record<string, string>>(csv: string): T[] {
  const out = Papa.parse<T>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  return (out.data || []).filter((r) => r && typeof r === "object");
}

export function normalizeBizName(s: string): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Fetch BaseSheet and return rows + multiple lookup maps:
 * - byCustomerId:      Chargebee customer_id → first row (legacy single-row lookup)
 * - byCustomerIdMulti: Chargebee customer_id → ALL rows (for multi-location customers)
 * - byEntityId:        Zoca entity_id → row
 * - byBizName:         normalized bizname → row (only for UNAMBIGUOUS names)
 */
/**
 * Supplement-CSV row shape (385231ff question).
 * Provides the 3 fields the new lean BaseSheet (e9005a5c) doesn't carry:
 * churn_potential_flag, churn_potential_status, open_tickets_30d.
 */
type SupplementRow = {
  entity_id: string;
  churn_potential_flag: string;
  churn_potential_status: string;
  open_tickets_30d: string;
};

/**
 * BS-2 (2026-06-10): Fetch the BaseSheet supplement CSV. Soft-fails to an
 * empty index so a supplement outage doesn't take Stage A down — the
 * affected fields will just go empty on the merged row.
 */
async function fetchBaseSheetSupplement(): Promise<Record<string, SupplementRow>> {
  try {
    const csv = await fetchCsvText(METABASE_ENDPOINTS.baseSheetSupplement);
    const raw = parseRows<Record<string, string>>(csv);
    const out: Record<string, SupplementRow> = {};
    for (const r of raw) {
      const eid = (r["entity_id"] || "").trim();
      if (!eid) continue;
      out[eid] = {
        entity_id: eid,
        churn_potential_flag: r["churn_potential_flag"] || "",
        churn_potential_status: r["churn_potential_status"] || "",
        open_tickets_30d: r["open_tickets_30d"] || "0",
      };
    }
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[fetchBaseSheetSupplement] failed — proceeding with empty supplement: ${msg}`,
    );
    return {};
  }
}

export async function fetchBaseSheet(): Promise<{
  rows: BaseSheetRow[];
  byCustomerId: Record<string, BaseSheetRow>;
  byCustomerIdMulti: Record<string, BaseSheetRow[]>;
  byEntityId: Record<string, BaseSheetRow>;
  byBizName: Record<string, BaseSheetRow>;
}> {
  // BS-2 (2026-06-10): Fetch lean BaseSheet (e9005a5c) + supplement (385231ff)
  // in parallel, then merge on entity_id. The lean CSV ships `mrr` instead of
  // `total_monthly_revenue`; alias here so downstream code (refresh.ts:
  // `mrr_basesheet: bs?.total_monthly_revenue || ""`) stays untouched.
  const [csv, supplementByEntity] = await Promise.all([
    fetchCsvText(METABASE_ENDPOINTS.baseSheet),
    fetchBaseSheetSupplement(),
  ]);
  const raw = parseRows<Record<string, string>>(csv);
  const rows: BaseSheetRow[] = raw.map((r) => {
    const eid = (r["entity_id"] || "").trim();
    const supp = supplementByEntity[eid];
    return {
      entity_id: eid,
      customer_id: (r["customer_id"] || "").trim(),
      bizname: r["bizname"] || "",
      am_name: r["am_name"] || "",
      ae_name: r["ae_name"] || "",
      sp_name: r["sp_name"] || "",
      app_email: r["app_email"] || "",
      phone_number: r["phone_number"] || "",
      // BS-2: lean CSV uses `mrr`; alias to legacy `total_monthly_revenue`
      // so downstream consumers don't have to change.
      total_monthly_revenue: r["total_monthly_revenue"] || r["mrr"] || "",
      chrone_zoca_status: r["chrone_zoca_status"] || "",
      // BS-2: supplement fields. Fall back to lean CSV's own value (in case
      // a future rev brings these back inline) before going empty.
      churn_potential_flag: r["churn_potential_flag"] || supp?.churn_potential_flag || "",
      churn_potential_status: r["churn_potential_status"] || supp?.churn_potential_status || "",
      ob_date: r["ob_date"] || "",
      open_tickets_30d: r["open_tickets_30d"] || supp?.open_tickets_30d || "0",
      // unresolved_issues_last_30_days is not in the new lean CSV nor the
      // supplement (the cx.open_issues source went stale on 2026-01-14).
      // Default to "0" so existing downstream readers keep working.
      unresolved_issues_last_30_days: r["unresolved_issues_last_30_days"] || "0",
    };
  });
  const byCustomerId: Record<string, BaseSheetRow> = {};
  const byCustomerIdMulti: Record<string, BaseSheetRow[]> = {};
  const byEntityId: Record<string, BaseSheetRow> = {};
  const bizNameGroups: Record<string, BaseSheetRow[]> = {};
  for (const r of rows) {
    if (r.customer_id) {
      byCustomerId[r.customer_id] = r;
      (byCustomerIdMulti[r.customer_id] = byCustomerIdMulti[r.customer_id] || []).push(r);
    }
    if (r.entity_id) byEntityId[r.entity_id] = r;
    const norm = normalizeBizName(r.bizname);
    if (norm) (bizNameGroups[norm] = bizNameGroups[norm] || []).push(r);
  }
  // Only include unambiguous bizname matches
  const byBizName: Record<string, BaseSheetRow> = {};
  for (const [k, v] of Object.entries(bizNameGroups)) {
    if (v.length === 1) byBizName[k] = v[0];
  }
  return { rows, byCustomerId, byCustomerIdMulti, byEntityId, byBizName };
}

