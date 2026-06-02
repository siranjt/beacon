/**
 * Miss Payment Beacon — Metabase BaseSheet enrichment.
 *
 * Pulls the public BaseSheet CSV (master mapping of customer_id /
 * entity_id / bizname / am_name / phone_number / email) and exposes
 * two lookup Maps keyed by customer_id and entity_id.
 *
 * Lives at `basesheet.ts` (not `metabase.ts`) so it doesn't collide
 * with the umbrella's existing `lib/metabase.ts` (used by Customer +
 * Performance Beacons for the Dataset API).
 *
 * 10-minute in-memory cache — BaseSheet changes infrequently and a
 * stale read here just shows yesterday's AM mapping, not financial
 * truth.
 */

import "server-only";
import Papa from "papaparse";

const BASE_SHEET_URL =
  process.env.METABASE_BASESHEET_URL ||
  "https://metabase.zoca.ai/public/question/87763e8c-8084-442e-891a-df1b11e81b47.csv";

let cache: { rows: any[]; ts: number } | null = null;
const TTL_MS = 10 * 60 * 1000;

export async function fetchBaseSheet(): Promise<any[]> {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) return cache.rows;
  const r = await fetch(BASE_SHEET_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`Metabase BaseSheet HTTP ${r.status}`);
  const text = await r.text();
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  cache = { rows: (parsed.data as any[]) || [], ts: now };
  return cache.rows;
}

export function indexBaseSheet(rows: any[]) {
  const byCustomerId = new Map<string, any>();
  const byEntityId = new Map<string, any>();
  for (const r of rows) {
    const c = (r.customer_id || "").trim();
    const e = (r.entity_id || "").trim();
    if (c) byCustomerId.set(c, r);
    if (e) byEntityId.set(e, r);
  }
  return { byCustomerId, byEntityId };
}
