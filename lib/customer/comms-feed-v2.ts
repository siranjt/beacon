/**
 * Phase E-19 W2.5 — per-entity comms feed via Metabase Dataset API.
 *
 * Previously this hit the public CSV endpoint of card fb775e8d. That worked
 * but had three problems: (1) no auth, so anyone with the URL could pull
 * arbitrary entity comms history, (2) CSV serialization added 2-4× the
 * latency of the JSON dataset endpoint, (3) Metabase session-level row caps
 * silently truncated high-volume customers.
 *
 * Post-cutover, we call the authenticated Dataset API directly
 * (POST /api/card/:id/query with x-api-key) and override the row cap via
 * `constraints.max-results`. Same parameter names (entity_id, lookback_days),
 * same SQL underneath, same CommsFeedRow output shape — callers don't change.
 *
 * Soft-fail contract is preserved: any fetch/parse error logs a warning and
 * returns []. In-memory 5-minute cache stays in place for the common case
 * of one page hitting the feed twice (timeline + perspective).
 */

const METABASE_BASE = process.env.METABASE_BASE || "https://metabase.zoca.ai";
const PER_ENTITY_CARD_ID = Number(
  process.env.METABASE_PER_ENTITY_COMMS_CARD_ID || "4051",
);
const PER_ENTITY_MAX_RESULTS = 25_000;

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

function readCol(row: Array<string | number | boolean | null>, idx: number | undefined): string {
  if (idx === undefined) return "";
  const v = row[idx];
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * Fetch the unified per-entity comms feed via Metabase Dataset API.
 *
 * @param entityId      UUID. Empty/missing returns [].
 * @param lookbackDays  Days back from today. `0` requests all-time;
 *                      anything <0 is clamped to 0.
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

  const apiKey = process.env.METABASE_API_KEY;
  if (!apiKey || !PER_ENTITY_CARD_ID) {
    console.warn(
      `[comms-feed-v2] METABASE_API_KEY or METABASE_PER_ENTITY_COMMS_CARD_ID missing — returning [] for ${entityId}`,
    );
    return [];
  }

  const body = {
    parameters: [
      {
        type: "category",
        value: entityId,
        target: ["variable", ["template-tag", "entity_id"]],
      },
      {
        type: "category",
        value: String(days),
        target: ["variable", ["template-tag", "lookback_days"]],
      },
    ],
    constraints: {
      "max-results": PER_ENTITY_MAX_RESULTS,
      "max-results-bare-rows": PER_ENTITY_MAX_RESULTS,
    },
  };

  try {
    const res = await fetch(`${METABASE_BASE}/api/card/${PER_ENTITY_CARD_ID}/query`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[comms-feed-v2] dataset-api HTTP ${res.status} for ${entityId}: ${text.slice(0, 200)}`,
      );
      return [];
    }
    const json = (await res.json()) as {
      data?: {
        rows?: Array<Array<string | number | boolean | null>>;
        cols?: Array<{ name: string }>;
      };
    };
    const cols = json.data?.cols || [];
    const rawRows = json.data?.rows || [];
    const idx = new Map(cols.map((c, i) => [c.name, i] as const));

    const rows: CommsFeedRow[] = [];
    for (const r of rawRows) {
      const eid = readCol(r, idx.get("entity_id")).trim();
      if (!eid) continue;
      const channel = parseChannel(readCol(r, idx.get("channel")));
      if (!channel) continue;
      const created_at = readCol(r, idx.get("created_at")).trim();
      const ts = parseTs(created_at);
      if (!Number.isFinite(ts)) continue;
      const bodyAvailRaw = readCol(r, idx.get("body_available")).trim().toLowerCase();
      const body_available =
        bodyAvailRaw === "true" || bodyAvailRaw === "t" || bodyAvailRaw === "1";
      rows.push({
        entity_id: eid,
        channel,
        subtype: readCol(r, idx.get("subtype")).trim(),
        created_at,
        ts,
        direction: parseDirection(readCol(r, idx.get("direction"))),
        sender_name: readCol(r, idx.get("sender_name")).trim(),
        message_body: readCol(r, idx.get("message_body")),
        body_available,
        source_id: readCol(r, idx.get("source_id")).trim(),
      });
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
