import Papa from "papaparse";
import { METABASE_ENDPOINTS, COMMS_RETAIN_DAYS } from "./config";
import type { BaseSheetRow, CommsEvent } from "./types";

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

function parseTs(s: string | undefined): number | null {
  if (!s) return null;
  const clean = s.trim();
  if (!clean) return null;
  const t = Date.parse(clean.endsWith("Z") ? clean : clean.includes("+") ? clean : clean + "Z");
  return Number.isFinite(t) ? t : null;
}

/**
 * Diagnostic stats from a comms-fetch, surfaced in the Data Health strip.
 * - rawRows: papaparse row count per source (regression test against raw CSV size)
 * - eventsKept: events that passed the date + direction filter
 * - eventsDeduped: events that survived our duplicate-event guard
 */
export type CommsParseStats = {
  rawRows: { chat: number; email: number; phone: number; video: number; sms: number };
  eventsKept: { chat: number; email: number; phone: number; video: number; sms: number };
  eventsDeduped: { chat: number; email: number; phone: number; video: number; sms: number };
  totalDuplicatesRemoved: number;
};

/**
 * Fetch + normalize all 5 comms feeds into a single array of CommsEvent.
 * Filters to the last COMMS_RETAIN_DAYS days to keep memory sane.
 *
 * Includes a duplicate-event guard: if the same (entityId, ts, channel, direction)
 * tuple shows up multiple times (which would indicate a CSV / runtime issue),
 * we only keep one copy.
 *
 * Directionality rules:
 *  - Chat:  Member Type = "Team Member" → out, "User" → in (Assistant/bot skipped)
 *  - Email: Sender = "Received_By_Client" → out (we sent), "Sent_By_Client" → in
 *  - Phone: Sender = "Initiated_By_Us" → out, "Initiated_By_Client" → in
 *  - Video: counted as mutual — one in + one out per meeting
 *  - SMS:   Sender = "Received_By_Client" → out, "Sent_By_Client" → in
 */
/** @deprecated Use fetchAllCommsSequential() instead. Kept for backward compat only. */
export async function fetchAllComms(
  todayMs: number,
): Promise<{ events: CommsEvent[]; stats: CommsParseStats }> {
  const cutoff = todayMs - COMMS_RETAIN_DAYS * 86400 * 1000;

  const [chatCsv, emailCsv, phoneCsv, videoCsv, smsCsv] = await Promise.all([
    fetchCsvText(METABASE_ENDPOINTS.chat),
    fetchCsvText(METABASE_ENDPOINTS.email),
    fetchCsvText(METABASE_ENDPOINTS.phone),
    fetchCsvText(METABASE_ENDPOINTS.video),
    fetchCsvText(METABASE_ENDPOINTS.sms),
  ]);

  const stats: CommsParseStats = {
    rawRows: { chat: 0, email: 0, phone: 0, video: 0, sms: 0 },
    eventsKept: { chat: 0, email: 0, phone: 0, video: 0, sms: 0 },
    eventsDeduped: { chat: 0, email: 0, phone: 0, video: 0, sms: 0 },
    totalDuplicatesRemoved: 0,
  };

  // Per-channel deduplication keyed by entity+ts+direction. Built per channel so a
  // genuine SMS at the same timestamp as a chat message both stay distinct.
  const seen: Record<CommsEvent["channel"], Set<string>> = {
    chat: new Set(), email: new Set(), phone: new Set(), video: new Set(), sms: new Set(),
  };
  const out: CommsEvent[] = [];
  const push = (eid: string, ts: number | null, channel: CommsEvent["channel"], direction: CommsEvent["direction"]) => {
    if (!eid || ts === null || ts < cutoff) return;
    stats.eventsKept[channel]++;
    const key = `${eid}|${ts}|${direction}`;
    if (seen[channel].has(key)) {
      stats.totalDuplicatesRemoved++;
      return;
    }
    seen[channel].add(key);
    stats.eventsDeduped[channel]++;
    out.push({ entityId: eid, ts, channel, direction });
  };

  // Chat
  const chatRows = parseRows<Record<string, string>>(chatCsv);
  stats.rawRows.chat = chatRows.length;
  for (const r of chatRows) {
    const eid = (r["Entity ID"] || "").trim();
    const ts = parseTs(r["Created At"]);
    const mt = r["Member Type"];
    if (mt === "Team Member") push(eid, ts, "chat", "out");
    else if (mt === "User") push(eid, ts, "chat", "in");
  }
  // Email
  const emailRows = parseRows<Record<string, string>>(emailCsv);
  stats.rawRows.email = emailRows.length;
  for (const r of emailRows) {
    const eid = (r["Entity ID"] || "").trim();
    const ts = parseTs(r["Created At"]);
    const s = r["Sender"];
    if (s === "Received_By_Client") push(eid, ts, "email", "out");
    else if (s === "Sent_By_Client") push(eid, ts, "email", "in");
  }
  // Phone
  const phoneRows = parseRows<Record<string, string>>(phoneCsv);
  stats.rawRows.phone = phoneRows.length;
  for (const r of phoneRows) {
    const eid = (r["Entity ID"] || "").trim();
    const ts = parseTs(r["Created At"]);
    const s = r["Sender"];
    if (s === "Initiated_By_Us") push(eid, ts, "phone", "out");
    else if (s === "Initiated_By_Client") push(eid, ts, "phone", "in");
  }
  // Video — mutual engagement (one in + one out per meeting)
  const videoRows = parseRows<Record<string, string>>(videoCsv);
  stats.rawRows.video = videoRows.length;
  for (const r of videoRows) {
    const eid = (r["Entity ID"] || "").trim();
    const ts = parseTs(r["Created At"]);
    push(eid, ts, "video", "in");
    push(eid, ts, "video", "out");
  }
  // SMS
  const smsRows = parseRows<Record<string, string>>(smsCsv);
  stats.rawRows.sms = smsRows.length;
  for (const r of smsRows) {
    const eid = (r["Entity ID"] || "").trim();
    const ts = parseTs(r["Created At"]);
    const s = r["Sender"];
    if (s === "Received_By_Client") push(eid, ts, "sms", "out");
    else if (s === "Sent_By_Client") push(eid, ts, "sms", "in");
  }

  // Surface in Vercel logs so we can spot anomalies even before the dashboard updates
  console.log("[fetchAllComms] raw rows:", stats.rawRows);
  console.log("[fetchAllComms] events kept (pre-dedup):", stats.eventsKept);
  console.log("[fetchAllComms] events kept (post-dedup):", stats.eventsDeduped);
  console.log("[fetchAllComms] total duplicates removed:", stats.totalDuplicatesRemoved);

  return { events: out, stats };
}

/**
 * Group comms events by entity_id for quick per-customer lookup.
 */
export function groupCommsByEntity(events: CommsEvent[]): Map<string, CommsEvent[]> {
  const m = new Map<string, CommsEvent[]>();
  for (const e of events) {
    const arr = m.get(e.entityId);
    if (arr) arr.push(e);
    else m.set(e.entityId, [e]);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Phase 2.1 — sequential per-channel comms processor.
//
// fetchAllComms() does Promise.all of 5 CSV fetches + buffered papaparse on
// all 5 → peak memory ~250MB+. On Hobby tier that's enough to OOM during
// cold-start variance. This variant processes one channel at a time inside
// scoped blocks so the per-channel CSV+rows go out of scope and become
// GC-eligible before the next channel starts.
//
// Same return shape as fetchAllComms. Used by Stage B (lib/refresh.ts).
// ---------------------------------------------------------------------------
export async function fetchAllCommsSequential(
  todayMs: number,
): Promise<{ events: CommsEvent[]; stats: CommsParseStats }> {
  const cutoff = todayMs - COMMS_RETAIN_DAYS * 86400 * 1000;

  const stats: CommsParseStats = {
    rawRows: { chat: 0, email: 0, phone: 0, video: 0, sms: 0 },
    eventsKept: { chat: 0, email: 0, phone: 0, video: 0, sms: 0 },
    eventsDeduped: { chat: 0, email: 0, phone: 0, video: 0, sms: 0 },
    totalDuplicatesRemoved: 0,
  };

  const seen: Record<CommsEvent["channel"], Set<string>> = {
    chat: new Set(), email: new Set(), phone: new Set(), video: new Set(), sms: new Set(),
  };
  const out: CommsEvent[] = [];
  const push = (
    eid: string,
    ts: number | null,
    channel: CommsEvent["channel"],
    direction: CommsEvent["direction"],
  ) => {
    if (!eid || ts === null || ts < cutoff) return;
    stats.eventsKept[channel]++;
    const key = `${eid}|${ts}|${direction}`;
    if (seen[channel].has(key)) {
      stats.totalDuplicatesRemoved++;
      return;
    }
    seen[channel].add(key);
    stats.eventsDeduped[channel]++;
    out.push({ entityId: eid, ts, channel, direction });
  };

  function memMark(label: string): void {
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    console.log(
      `[mem comms ${label}] rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB out=${out.length}`,
    );
  }

  // ----- Chat -----
  {
    const csv = await fetchCsvText(METABASE_ENDPOINTS.chat);
    const rows = parseRows<Record<string, string>>(csv);
    stats.rawRows.chat = rows.length;
    for (const r of rows) {
      const eid = (r["Entity ID"] || "").trim();
      const ts = parseTs(r["Created At"]);
      const mt = r["Member Type"];
      if (mt === "Team Member") push(eid, ts, "chat", "out");
      else if (mt === "User") push(eid, ts, "chat", "in");
    }
  }
  memMark("after chat");

  // ----- Email -----
  {
    const csv = await fetchCsvText(METABASE_ENDPOINTS.email);
    const rows = parseRows<Record<string, string>>(csv);
    stats.rawRows.email = rows.length;
    for (const r of rows) {
      const eid = (r["Entity ID"] || "").trim();
      const ts = parseTs(r["Created At"]);
      const s = r["Sender"];
      if (s === "Received_By_Client") push(eid, ts, "email", "out");
      else if (s === "Sent_By_Client") push(eid, ts, "email", "in");
    }
  }
  memMark("after email");

  // ----- Phone -----
  {
    const csv = await fetchCsvText(METABASE_ENDPOINTS.phone);
    const rows = parseRows<Record<string, string>>(csv);
    stats.rawRows.phone = rows.length;
    for (const r of rows) {
      const eid = (r["Entity ID"] || "").trim();
      const ts = parseTs(r["Created At"]);
      const s = r["Sender"];
      if (s === "Initiated_By_Us") push(eid, ts, "phone", "out");
      else if (s === "Initiated_By_Client") push(eid, ts, "phone", "in");
    }
  }
  memMark("after phone");

  // ----- Video (mutual — each row counts as both in + out) -----
  {
    const csv = await fetchCsvText(METABASE_ENDPOINTS.video);
    const rows = parseRows<Record<string, string>>(csv);
    stats.rawRows.video = rows.length;
    for (const r of rows) {
      const eid = (r["Entity ID"] || "").trim();
      const ts = parseTs(r["Created At"]);
      push(eid, ts, "video", "in");
      push(eid, ts, "video", "out");
    }
  }
  memMark("after video");

  // ----- SMS -----
  {
    const csv = await fetchCsvText(METABASE_ENDPOINTS.sms);
    const rows = parseRows<Record<string, string>>(csv);
    stats.rawRows.sms = rows.length;
    for (const r of rows) {
      const eid = (r["Entity ID"] || "").trim();
      const ts = parseTs(r["Created At"]);
      const s = r["Sender"];
      if (s === "Received_By_Client") push(eid, ts, "sms", "out");
      else if (s === "Sent_By_Client") push(eid, ts, "sms", "in");
    }
  }
  memMark("after sms");

  console.log("[fetchAllCommsSequential] raw rows:", stats.rawRows);
  console.log("[fetchAllCommsSequential] events kept:", stats.eventsDeduped);
  console.log("[fetchAllCommsSequential] duplicates removed:", stats.totalDuplicatesRemoved);

  return { events: out, stats };
}
