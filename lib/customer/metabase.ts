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
export async function fetchBaseSheet(): Promise<{
  rows: BaseSheetRow[];
  byCustomerId: Record<string, BaseSheetRow>;
  byCustomerIdMulti: Record<string, BaseSheetRow[]>;
  byEntityId: Record<string, BaseSheetRow>;
  byBizName: Record<string, BaseSheetRow>;
}> {
  const csv = await fetchCsvText(METABASE_ENDPOINTS.baseSheet);
  const raw = parseRows<Record<string, string>>(csv);
  const rows: BaseSheetRow[] = raw.map((r) => ({
    entity_id: (r["entity_id"] || "").trim(),
    customer_id: (r["customer_id"] || "").trim(),
    bizname: r["bizname"] || "",
    am_name: r["am_name"] || "",
    ae_name: r["ae_name"] || "",
    sp_name: r["sp_name"] || "",
    app_email: r["app_email"] || "",
    phone_number: r["phone_number"] || "",
    total_monthly_revenue: r["total_monthly_revenue"] || "",
    chrone_zoca_status: r["chrone_zoca_status"] || "",
    churn_potential_flag: r["churn_potential_flag"] || "",
    churn_potential_status: r["churn_potential_status"] || "",
    ob_date: r["ob_date"] || "",
    open_tickets_30d: r["open_tickets_30d"] || "0",
    unresolved_issues_last_30_days: r["unresolved_issues_last_30_days"] || "0",
  }));
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

