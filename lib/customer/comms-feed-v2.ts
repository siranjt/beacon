/**
 * Phase E-18 — per-entity comms feed v2.
 *
 * Backed by the validated COMMS-2 Metabase public question which returns a
 * unified per-entity comms feed (chat + email + phone + video + sms) with
 * full message bodies and meeting transcripts in a single CSV.
 *
 * URL pattern (stable; the UUIDs are baked into the question definition —
 * not secrets, not env-ified):
 *
 *   https://metabase.zoca.ai/public/question/fb775e8d-f7be-49d5-b573-e89a45407f14.csv
 *     ?parameters=<URL-encoded JSON array>
 *
 * The JSON array uses Metabase's canonical parameter format. We pin BOTH
 * entity_id and lookback_days through it. `lookback_days = 0` returns
 * all-time; the perspective layer caps at 90 to keep token cost bounded.
 *
 * Soft-fail contract: any fetch / parse error logs a warning and returns
 * `[]`. Downstream callers (Haiku perspective builder + the per-entity 360
 * page) must never crash because the feed is slow or returning HTML.
 *
 * In-memory cache: repeated calls within one server request (e.g. the 360
 * page hits the feed twice — once for the timeline, once for the
 * perspective builder) skip the second network round trip. Five-minute TTL
 * is plenty for a server-render lifetime; we never want stale comms
 * showing up tomorrow.
 *
 * IMPORTANT: this helper lives alongside `lib/customer/comms-for-entity.ts`
 * — that older fetcher pulls 5 separate CSVs in parallel and is what
 * existing UI callers rely on. New code prefers comms-feed-v2 for the
 * unified shape; old callers will be migrated piecemeal.
 */
import Papa from "papaparse";

const COMMS_FEED_URL =
  "https://metabase.zoca.ai/public/question/fb775e8d-f7be-49d5-b573-e89a45407f14.csv";

// Stable Metabase parameter UUIDs — pinned in the public question.
const ENTITY_ID_PARAM = "75994161-5d9f-44d3-b327-c8c4b512a659";
const LOOKBACK_PARAM = "88c5b401-0b56-4953-9caa-5148ea16bcf2";

export type CommsFeedChannel = "chat" | "email" | "phone" | "video" | "sms";
export type CommsFeedDirection = "inbound" | "outbound" | "system";

export interface CommsFeedRow {
  entity_id: string;
  channel: CommsFeedChannel;
  subtype: string;
  created_at: string; // ISO
  ts: number;        // epoch ms (derived from created_at)
  direction: CommsFeedDirection;
  sender_name: string;
  message_body: string;
  body_available: boolean;
  source_id: string;
}

interface CacheEntry {
  rows: CommsFeedRow[];
  ts: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function buildParams(entityId: string, lookbackDays: number): string {
  const arr = [
    {
      id: ENTITY_ID_PARAM,
      type: "category",
      value: entityId,
      target: ["variable", ["template-tag", "entity_id"]],
    },
    {
      id: LOOKBACK_PARAM,
      type: "category",
      value: String(lookbackDays),
      target: ["variable", ["template-tag", "lookback_days"]],
    },
  ];
  return encodeURIComponent(JSON.stringify(arr));
}

function parseChannel(s: string): CommsFeedChannel | null {
  const v = (s || "").trim().toLowerCase();
  if (v === "chat" || v === "email" || v === "phone" || v === "video" || v === "sms") {
    return v;
  }
  return null;
}

function parseDirection(s: string): CommsFeedDirection {
  const v = (s || "").trim().toLowerCase();
  if (v === "inbound" || v === "outbound" || v === "system") return v;
  return "system";
}

function parseTs(s: string): number {
  if (!s) return NaN;
  const clean = s.trim();
  if (!clean) return NaN;
  const withZone = clean.endsWith("Z") || clean.includes("+") ? clean : `${clean}Z`;
  return Date.parse(withZone);
}

function parseRow(raw: Record<string, string>): CommsFeedRow | null {
  const entity_id = (raw["entity_id"] ?? "").trim();
  if (!entity_id) return null;
  const channel = parseChannel(raw["channel"] ?? "");
  if (!channel) return null;
  const created_at = (raw["created_at"] ?? "").trim();
  const ts = parseTs(created_at);
  if (!Number.isFinite(ts)) return null;
  const bodyAvailRaw = (raw["body_available"] ?? "").trim().toLowerCase();
  const body_available = bodyAvailRaw === "true" || bodyAvailRaw === "t" || bodyAvailRaw === "1";
  return {
    entity_id,
    channel,
    subtype: (raw["subtype"] ?? "").trim(),
    created_at,
    ts,
    direction: parseDirection(raw["direction"] ?? ""),
    sender_name: (raw["sender_name"] ?? "").trim(),
    message_body: raw["message_body"] ?? "",
    body_available,
    source_id: (raw["source_id"] ?? "").trim(),
  };
}

/**
 * Fetch the unified per-entity comms feed.
 *
 * @param entityId      UUID. Empty/missing returns [].
 * @param lookbackDays  Days back from today. `0` requests all-time;
 *                      anything <0 is clamped to 0. The Metabase question
 *                      enforces a server-side cap too.
 *
 * Returns rows sorted newest-first. Soft-fails to [] with a warning log.
 */
export async function fetchCommsFeed(
  entityId: string,
  lookbackDays: number = 90,
): Promise<CommsFeedRow[]> {
  if (!entityId) return [];
  const days = Math.max(0, Math.floor(lookbackDays));
  const cacheKey = `${entityId}::${days}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return hit.rows;
  }

  const url = `${COMMS_FEED_URL}?parameters=${buildParams(entityId, days)}`;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      headers: { Accept: "text/csv" },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[comms-feed-v2] HTTP ${res.status} for ${entityId}: ${text.slice(0, 200)}`,
      );
      return [];
    }
    const csv = await res.text();
    const parsed = Papa.parse<Record<string, string>>(csv, {
      header: true,
      skipEmptyLines: true,
    });
    const rows: CommsFeedRow[] = [];
    for (const raw of parsed.data ?? []) {
      if (!raw || typeof raw !== "object") continue;
      const row = parseRow(raw);
      if (row) rows.push(row);
    }
    rows.sort((a, b) => b.ts - a.ts);
    cache.set(cacheKey, { rows, ts: Date.now() });
    return rows;
  } catch (e) {
    console.warn(
      `[comms-feed-v2] fetch failed for ${entityId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return [];
  }
}

/** Internal — exposed for unit tests that want to clear state between cases. */
export function _clearCommsFeedCache(): void {
  cache.clear();
}
