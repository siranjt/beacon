/**
 * Metabase CSV fetchers + per-entity / per-time-window filters.
 *
 * Sources are public-question CSV endpoints. Each is a redirect — fetch must
 * follow the 302. We stream-parse with csv-parse to avoid loading 100MB+ into
 * memory all at once.
 */

import { parse } from "csv-parse";
import { Readable } from "node:stream";

const SOURCES = {
  basesheet: "https://metabase.zoca.ai/public/question/87763e8c-8084-442e-891a-df1b11e81b47.csv",
  comms_app_chat: "https://metabase.zoca.ai/public/question/10a52e37-04fa-4422-b840-803b66e033bf.csv",
  comms_email: "https://metabase.zoca.ai/public/question/7a5aa1f6-9205-4e83-be51-3e585aa0f4a8.csv",
  comms_phone_calls: "https://metabase.zoca.ai/public/question/60797a27-c546-450d-b00b-a51b7e490143.csv",
  comms_video_calls: "https://metabase.zoca.ai/public/question/d95d9354-7c84-4a57-8af5-e700580c6ecb.csv",
  comms_sms: "https://metabase.zoca.ai/public/question/bbaad2fb-5f9d-4249-af59-c7812851437c.csv",
  booking_platform: "https://metabase.zoca.ai/public/question/4d3a953e-7223-4030-ba85-66ae19d7b49e.csv",
  business_opening_date: "https://metabase.zoca.ai/public/question/8b6f5349-5438-46df-b64e-07979d392b65.csv",
  review_metrics: "https://metabase.zoca.ai/public/question/88a7ea2a-5a24-4b34-a712-e4dbdf2a197b.csv",
} as const;

type SourceKey = keyof typeof SOURCES;

async function streamCsv(url: string): Promise<Readable> {
  const res = await fetch(url, { redirect: "follow", headers: { "accept-encoding": "gzip" } });
  if (!res.ok) throw new Error(`metabase ${url} ${res.status}`);
  if (!res.body) throw new Error(`metabase ${url} no body`);
  return Readable.fromWeb(res.body as any);
}

async function fetchAndFilter(
  source: SourceKey,
  predicate: (row: Record<string, string>) => boolean,
): Promise<Record<string, string>[]> {
  const stream = await streamCsv(SOURCES[source]);
  const out: Record<string, string>[] = [];
  await new Promise<void>((resolve, reject) => {
    stream
      .pipe(parse({ columns: true, relax_quotes: true, skip_empty_lines: true, trim: true }))
      .on("data", (row: Record<string, string>) => { if (predicate(row)) out.push(row); })
      .on("end", () => resolve())
      .on("error", reject);
  });
  return out;
}

// --- BaseSheet ---------------------------------------------------------------

export async function basesheetForCustomer(customerId: string): Promise<Record<string, string>[]> {
  return fetchAndFilter("basesheet", row => row.customer_id === customerId);
}

// --- Comms (5 channels) ------------------------------------------------------

const COMMS_KEYS: SourceKey[] = ["comms_app_chat", "comms_email", "comms_phone_calls", "comms_video_calls", "comms_sms"];

export type CommsResult = Record<string, Record<string, string>[]>;

function parseTimestamp(raw?: string): number | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  if (!isNaN(t)) return Math.floor(t / 1000);
  // bare "YYYY-MM-DD HH:MM:SS" without TZ → treat as UTC
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (m) {
    const t2 = Date.parse(`${m[1]}T${m[2]}Z`);
    if (!isNaN(t2)) return Math.floor(t2 / 1000);
  }
  return null;
}

function inferDirection(row: Record<string, string>, channel: string): "inbound" | "outbound" | "meeting" | "unknown" {
  const sender = (row.Sender ?? "").toLowerCase();
  const member = (row["Member Type"] ?? "").toLowerCase();
  if (channel === "comms_app_chat") {
    if (member === "team member") return "outbound";
    if (member === "user") return "inbound";
  }
  if (channel === "comms_email" || channel === "comms_sms") {
    if (sender.includes("received_by_client")) return "outbound";
    if (sender.includes("sent_by_client")) return "inbound";
  }
  if (channel === "comms_phone_calls") {
    if (sender.includes("initiated_by_us")) return "outbound";
    if (sender.includes("initiated_by_client")) return "inbound";
  }
  if (channel === "comms_video_calls") return "meeting";
  return "unknown";
}

export async function commsForEntities(args: {
  entityIds: Set<string>;
  cutoffUnix: number;
  windowDays: number;
}): Promise<CommsResult> {
  const windowStart = args.cutoffUnix - args.windowDays * 86400;
  const out: CommsResult = {};
  for (const channel of COMMS_KEYS) {
    const rows = await fetchAndFilter(channel, row => {
      const eid = row["Entity ID"] ?? row["entity_id"];
      if (!eid || !args.entityIds.has(eid)) return false;
      const ts = parseTimestamp(row["Created At"] ?? row["created_at"]);
      return ts !== null && ts >= windowStart && ts <= args.cutoffUnix;
    });
    out[channel] = rows.map(r => ({
      ...r,
      _unix_ts: String(parseTimestamp(r["Created At"] ?? r["created_at"]) ?? ""),
      _channel: channel,
      _direction: inferDirection(r, channel),
    }));
  }
  return out;
}

// --- Booking platform --------------------------------------------------------

export async function bookingPlatformForEntity(entityId: string) {
  return fetchAndFilter("booking_platform", row => row["Entity ID"] === entityId);
}

// --- Business opening date ---------------------------------------------------

export async function openingDateForEntity(entityId: string) {
  return fetchAndFilter("business_opening_date", row => row["Entity ID"] === entityId);
}

// --- Review metrics ----------------------------------------------------------

export async function reviewMetricsForEntity(entityId: string): Promise<Record<string, string> | null> {
  const rows = await fetchAndFilter("review_metrics", row => row.entity_id === entityId);
  return rows[0] ?? null;
}
