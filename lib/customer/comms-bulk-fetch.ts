/**
 * Phase E-19 Wave 1 — bulk comms events fetcher.
 *
 * Source: Metabase question "Beacon Bulk Comms Events" (card 4052,
 * public_uuid ac8893a6-…). Returns dedup'd events for an arbitrary set
 * of entity_ids over a lookback window.
 *
 * Two transport paths, picked automatically:
 *
 *   1. Dataset API (preferred): POST /api/card/4052/query with x-api-key.
 *      Single round trip for all 907 entities. ~10s. Requires the API
 *      key's linked user/group to have execute privilege on the
 *      collection holding card 4052. As of this writing, that grant is
 *      missing and Metabase returns 403. Set METABASE_BULK_USE_DATASET_API
 *      to "1" after the permission is granted.
 *
 *   2. Public CSV (fallback): GET <public CSV URL>?parameters=<json> with
 *      chunked entity_ids. URL is capped around 8KB (HTTP 414 at n=200);
 *      chunk_size=150 stays safely under. Chunks fetched in parallel
 *      with bounded concurrency. ~3-5min for the full 907 depending on
 *      Metabase concurrency throttling.
 *
 * Both paths return the same CommsEventRow shape so the caller doesn't
 * see the transport.
 *
 * Column mapping (bulk question returns slimmer shape than per-entity):
 *   customer_entity_id → entity_id
 *   channel            → channel
 *   subtype            → subtype
 *   created_at         → created_at (normalized to ISO)
 *   direction          → direction
 *   source_id          → source_id
 *   (no sender_name)   → null
 *   (no body_available)→ false  (drill-down query has it; bulk doesn't
 *                                because Stage B doesn't need it)
 *
 * Soft-fail: any HTTP error / parse failure logs a warning and returns
 * []. Dual-source Stage B keeps running on the V1 path.
 */

import Papa from "papaparse";
import type { CommsChannel, CommsDirection, CommsEventRow } from "./comms-events-store";

const MB_BASE = process.env.METABASE_BASE || "https://metabase.zoca.ai";
const BULK_CARD_ID = Number(process.env.METABASE_BULK_COMMS_CARD_ID || "4052");
const BULK_PUBLIC_UUID =
  process.env.METABASE_BULK_COMMS_PUBLIC_UUID || "ac8893a6-f53f-42b2-9cd1-49eed3ed33c3";
const PER_ENTITY_CARD_ID = Number(process.env.METABASE_PER_ENTITY_COMMS_CARD_ID || "4051");

/**
 * Dataset-API chunk size. Measured scaling (May 2026):
 *   n=3  → 5.4s   n=10 → 9.8s   n=100 → >40s timeout
 * Per-entity cost ~0.4-0.5s on top of ~5s fixed. The SQL doesn't push
 * the entity_ids filter through its dedup CTE efficiently, so batches
 * above ~50 entities hit Vercel function timeouts. Batch=30 hits ~15s
 * per call, leaving headroom.
 *
 * If/when the SQL is optimized (push the IN-filter into each channel
 * subquery before UNION + ROW_NUMBER), this can grow back toward
 * single-call. Tracked as Wave 1 follow-up.
 */
const BULK_DATASET_CHUNK_SIZE = 30;
/** Parallel chunk fetches. Metabase + Aurora tolerate ~6-8 concurrent
 *  query executions before queueing. 6 keeps headroom. */
const BULK_DATASET_CONCURRENCY = 6;
const BULK_DATASET_TIMEOUT_MS = 60_000;

/** Public CSV chunk size — stays under Metabase's ~8KB URL cap. */
const PUBLIC_CSV_CHUNK_SIZE = 150;
/** Concurrent CSV chunk fetches. Metabase tolerates ~3-4 parallel
 *  query executions on Aurora; higher risks queue contention. */
const PUBLIC_CSV_CONCURRENCY = 4;
const PUBLIC_CSV_TIMEOUT_MS = 120_000;

function parseChannel(s: unknown): CommsChannel | null {
  const v = String(s ?? "").trim().toLowerCase();
  if (v === "chat" || v === "email" || v === "phone" || v === "sms" || v === "video") return v;
  return null;
}

function parseDirection(s: unknown): CommsDirection {
  const v = String(s ?? "").trim().toLowerCase();
  if (v === "inbound" || v === "outbound" || v === "system") return v;
  return "system";
}

function parseIso(s: unknown): string | null {
  if (!s) return null;
  const v = String(s).trim();
  if (!v) return null;
  const normalized = v.includes("T") ? v : v.replace(" ", "T").replace(/\+00:?00?$/, "Z");
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * Build CommsEventRow[] from raw CSV/dataset rows. Tolerates either
 * column name (customer_entity_id from bulk, entity_id from per-entity).
 */
function rowsToEvents(
  rows: Array<Record<string, string | null | undefined>>,
): CommsEventRow[] {
  const out: CommsEventRow[] = [];
  for (const r of rows) {
    const entity_id = String(r["customer_entity_id"] ?? r["entity_id"] ?? "").trim();
    if (!entity_id) continue;
    const channel = parseChannel(r["channel"]);
    if (!channel) continue;
    const source_id = String(r["source_id"] ?? "").trim();
    if (!source_id) continue;
    const created_at = parseIso(r["created_at"]);
    if (!created_at) continue;
    const subtype = (() => {
      const v = r["subtype"];
      if (v === undefined || v === null) return null;
      const s = String(v).trim();
      return s || null;
    })();
    const sender_name = (() => {
      const v = r["sender_name"];
      if (v === undefined || v === null) return null;
      const s = String(v).trim();
      return s || null;
    })();
    const body_available = (() => {
      const v = r["body_available"];
      if (v === undefined || v === null) return false;
      const s = String(v).trim().toLowerCase();
      return s === "true" || s === "t" || s === "1";
    })();
    out.push({
      entity_id,
      channel,
      source_id,
      direction: parseDirection(r["direction"]),
      subtype,
      sender_name,
      body_available,
      created_at,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transport: Dataset API (preferred, blocked on Metabase RBAC as of writing)
// ---------------------------------------------------------------------------

/** Single attempt at the chunk fetch — no retry layer here. */
async function fetchOneDatasetApiChunkAttempt(
  entityIds: string[],
  lookbackDays: number,
): Promise<{ ok: true; events: CommsEventRow[] } | { ok: false; status: number; message: string }> {
  const apiKey = process.env.METABASE_API_KEY;
  if (!apiKey || !BULK_CARD_ID) {
    return { ok: false, status: 0, message: "missing METABASE_API_KEY or card_id" };
  }

  // constraints.max-results overrides Metabase's session-level row cap
  // (default 2000). Without this, high-volume customers in a single chunk
  // get their older events silently truncated.
  const body = {
    parameters: [
      {
        type: "category",
        value: entityIds.join(","),
        target: ["variable", ["template-tag", "entity_ids"]],
      },
      {
        type: "category",
        value: String(Math.max(0, Math.floor(lookbackDays))),
        target: ["variable", ["template-tag", "lookback_days"]],
      },
    ],
    constraints: {
      "max-results": 100000,
      "max-results-bare-rows": 100000,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BULK_DATASET_TIMEOUT_MS);
  try {
    const res = await fetch(`${MB_BASE}/api/card/${BULK_CARD_ID}/query`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        message: text.slice(0, 200) || `HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as {
      data?: {
        rows?: Array<Array<string | number | boolean | null>>;
        cols?: Array<{ name: string }>;
      };
    };
    const cols = json.data?.cols || [];
    const rawRows = json.data?.rows || [];
    const out: Array<Record<string, string>> = [];
    for (const r of rawRows) {
      const obj: Record<string, string> = {};
      cols.forEach((c, i) => {
        obj[c.name] = r[i] == null ? "" : String(r[i]);
      });
      out.push(obj);
    }
    const events = rowsToEvents(out);
    return { ok: true, events };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: -1, message: message.slice(0, 200) };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fire one Dataset API call for `entityIds` with retry-on-failure.
 *
 * Returns:
 *   - events array on success (possibly after retries)
 *   - null if the FIRST attempt returned 403 (auth issue — caller bails to CSV)
 *   - [] if all retries failed for a non-auth reason; logs the entity_ids that
 *     lost data so ops can see which customers are missing V2 coverage
 *
 * Retry policy: up to 3 attempts with 1s, 2s exponential backoff.
 * 403 short-circuits (no retry — perms aren't going to fix themselves).
 */
async function fetchOneDatasetApiChunk(
  entityIds: string[],
  lookbackDays: number,
): Promise<CommsEventRow[] | null> {
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [0, 1000, 2000];

  const t0 = Date.now();
  let lastError: { status: number; message: string } | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (BACKOFF_MS[attempt - 1] > 0) {
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt - 1]));
    }
    const result = await fetchOneDatasetApiChunkAttempt(entityIds, lookbackDays);
    if (result.ok) {
      console.log(
        `[comms-bulk-fetch] dataset-api chunk OK: ${result.events.length} events for ${entityIds.length} entities in ${Date.now() - t0}ms (attempt ${attempt}/${MAX_ATTEMPTS})`,
      );
      return result.events;
    }
    lastError = { status: result.status, message: result.message };
    console.warn(
      `[comms-bulk-fetch] dataset-api chunk attempt ${attempt}/${MAX_ATTEMPTS} failed (n=${entityIds.length}): HTTP ${result.status}: ${result.message}`,
    );
    // 403 is a perms issue — retrying won't help, and caller needs to fall
    // back to the CSV path. Return null to signal "transport unavailable".
    if (result.status === 403) {
      return null;
    }
  }

  // All retries exhausted. Log the entity_ids that lost V2 coverage so the
  // ops team can identify the impact and decide whether to manually re-fire.
  console.error(
    `[comms-bulk-fetch] CHUNK LOST after ${MAX_ATTEMPTS} attempts — ${entityIds.length} entities will have 0 V2 events. Last error: HTTP ${lastError?.status}: ${lastError?.message}. Entity IDs: ${entityIds.slice(0, 5).join(", ")}${entityIds.length > 5 ? `, ... +${entityIds.length - 5} more` : ""}`,
  );
  return [];
}

/**
 * Dataset API transport — chunks + parallel concurrency.
 *
 * Chunking is required NOT for URL length (POST body has no limit) but
 * because the bulk SQL has bad scaling: single-call for n=907 would
 * take ~5-7 minutes and exceed Vercel function timeouts. Chunked
 * batch=30 × concurrency=6 → ~90s wall time for the full book.
 *
 * Returns null if the FIRST chunk reports 403 (transport
 * unavailable; caller falls back to public CSV path). Otherwise
 * returns the union of all chunks' events.
 */
async function fetchViaDatasetApi(
  entityIds: string[],
  lookbackDays: number,
): Promise<CommsEventRow[] | null> {
  if (entityIds.length === 0) return [];
  const apiKey = process.env.METABASE_API_KEY;
  if (!apiKey || !BULK_CARD_ID) return null;

  // Build chunks
  const chunks: string[][] = [];
  for (let i = 0; i < entityIds.length; i += BULK_DATASET_CHUNK_SIZE) {
    chunks.push(entityIds.slice(i, i + BULK_DATASET_CHUNK_SIZE));
  }

  const t0 = Date.now();
  // Probe with the first chunk first — if it returns null (403), bail
  // out before firing the rest in parallel.
  const probe = await fetchOneDatasetApiChunk(chunks[0], lookbackDays);
  if (probe === null) {
    console.warn(
      `[comms-bulk-fetch] dataset-api probe returned null (perms issue) — caller falls back to CSV`,
    );
    return null;
  }
  const out: CommsEventRow[] = [...probe];

  // Run remaining chunks with bounded concurrency
  if (chunks.length > 1) {
    let cursor = 1;
    const worker = async (): Promise<void> => {
      while (cursor < chunks.length) {
        const i = cursor++;
        const events = await fetchOneDatasetApiChunk(chunks[i], lookbackDays);
        if (events) out.push(...events);
      }
    };
    const workers = Array.from(
      { length: Math.min(BULK_DATASET_CONCURRENCY, chunks.length - 1) },
      () => worker(),
    );
    await Promise.all(workers);
  }

  console.log(
    `[comms-bulk-fetch] dataset-api: ${out.length} events for ${entityIds.length} entities across ${chunks.length} chunks in ${Date.now() - t0}ms`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Transport: Public CSV with chunking + bounded concurrency (fallback)
// ---------------------------------------------------------------------------

function buildPublicCsvUrl(entityIds: string[], lookbackDays: number): string {
  const params = [
    {
      type: "category",
      value: entityIds.join(","),
      target: ["variable", ["template-tag", "entity_ids"]],
    },
    {
      type: "category",
      value: String(Math.max(0, Math.floor(lookbackDays))),
      target: ["variable", ["template-tag", "lookback_days"]],
    },
  ];
  return `${MB_BASE}/public/question/${BULK_PUBLIC_UUID}.csv?parameters=${encodeURIComponent(JSON.stringify(params))}`;
}

async function fetchOneCsvChunk(
  entityIds: string[],
  lookbackDays: number,
): Promise<CommsEventRow[]> {
  const url = buildPublicCsvUrl(entityIds, lookbackDays);
  if (url.length > 7800) {
    // Defensive — this shouldn't happen with chunk_size=150 but log it
    // if some future entity_id format expands the URL.
    console.warn(`[comms-bulk-fetch] CSV url length ${url.length} > 7800, may 414`);
  }
  const t0 = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PUBLIC_CSV_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/csv" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[comms-bulk-fetch] csv chunk HTTP ${res.status} for ${entityIds.length} entities: ${text.slice(0, 200)}`,
      );
      return [];
    }
    const csv = await res.text();
    const parsed = Papa.parse<Record<string, string>>(csv, {
      header: true,
      skipEmptyLines: true,
    });
    const events = rowsToEvents(parsed.data || []);
    console.log(
      `[comms-bulk-fetch] csv chunk: ${events.length} events for ${entityIds.length} entities in ${Date.now() - t0}ms`,
    );
    return events;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[comms-bulk-fetch] csv chunk failed: ${message}`);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchViaPublicCsv(
  entityIds: string[],
  lookbackDays: number,
): Promise<CommsEventRow[]> {
  // Chunk
  const chunks: string[][] = [];
  for (let i = 0; i < entityIds.length; i += PUBLIC_CSV_CHUNK_SIZE) {
    chunks.push(entityIds.slice(i, i + PUBLIC_CSV_CHUNK_SIZE));
  }

  // Bounded concurrency executor
  const out: CommsEventRow[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < chunks.length) {
      const i = cursor++;
      const events = await fetchOneCsvChunk(chunks[i], lookbackDays);
      out.push(...events);
    }
  };
  const workers = Array.from(
    { length: Math.min(PUBLIC_CSV_CONCURRENCY, chunks.length) },
    () => worker(),
  );
  const t0 = Date.now();
  await Promise.all(workers);
  console.log(
    `[comms-bulk-fetch] csv: ${out.length} events for ${entityIds.length} entities across ${chunks.length} chunks in ${Date.now() - t0}ms`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the bulk comms-events question for the given entity_ids.
 * Tries Dataset API first if METABASE_BULK_USE_DATASET_API=1; falls back
 * to chunked public CSV. Returns CommsEventRow[].
 */
export async function fetchBulkCommsEvents(
  entityIds: string[],
  lookbackDays = 90,
): Promise<CommsEventRow[]> {
  if (entityIds.length === 0) return [];

  if (process.env.METABASE_BULK_USE_DATASET_API === "1") {
    const events = await fetchViaDatasetApi(entityIds, lookbackDays);
    if (events !== null) return events;
    console.warn("[comms-bulk-fetch] dataset-api unavailable, falling back to public CSV");
  }
  return fetchViaPublicCsv(entityIds, lookbackDays);
}

/**
 * Per-entity drill-down. Calls the per-entity Metabase question (card
 * UUID fb775e8d-…) via Dataset API by card_id if METABASE_PER_ENTITY_COMMS_CARD_ID
 * is set, otherwise via public CSV. Used by Customer 360 timeline and
 * AskPanel context loaders that need a fresh single-customer read.
 *
 * Returns events with sender_name + body_available populated (the
 * per-entity question's SELECT includes them; the bulk SELECT doesn't).
 */
export async function fetchPerEntityCommsEvents(
  entityId: string,
  lookbackDays = 90,
): Promise<CommsEventRow[]> {
  if (!entityId) return [];

  const apiKey = process.env.METABASE_API_KEY;
  if (process.env.METABASE_PER_ENTITY_USE_DATASET_API === "1" && apiKey && PER_ENTITY_CARD_ID) {
    const body = {
      parameters: [
        {
          type: "category",
          value: entityId,
          target: ["variable", ["template-tag", "entity_id"]],
        },
        {
          type: "category",
          value: String(Math.max(0, Math.floor(lookbackDays))),
          target: ["variable", ["template-tag", "lookback_days"]],
        },
      ],
    };
    try {
      const res = await fetch(`${MB_BASE}/api/card/${PER_ENTITY_CARD_ID}/query`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: {
            rows?: Array<Array<string | number | boolean | null>>;
            cols?: Array<{ name: string }>;
          };
        };
        const cols = json.data?.cols || [];
        const rawRows = json.data?.rows || [];
        const out: Array<Record<string, string>> = [];
        for (const r of rawRows) {
          const obj: Record<string, string> = {};
          cols.forEach((c, i) => {
            obj[c.name] = r[i] == null ? "" : String(r[i]);
          });
          out.push(obj);
        }
        return rowsToEvents(out);
      }
      const text = await res.text().catch(() => "");
      console.warn(
        `[comms-bulk-fetch] per-entity dataset-api HTTP ${res.status}: ${text.slice(0, 200)} — falling back to public CSV`,
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[comms-bulk-fetch] per-entity dataset-api failed: ${message}`);
    }
  }

  // Public CSV fallback — fb775e8d is published as a public question.
  const PER_ENTITY_PUBLIC_UUID =
    process.env.METABASE_PER_ENTITY_COMMS_PUBLIC_UUID ||
    "fb775e8d-f7be-49d5-b573-e89a45407f14";
  const params = [
    {
      type: "category",
      value: entityId,
      target: ["variable", ["template-tag", "entity_id"]],
    },
    {
      type: "category",
      value: String(Math.max(0, Math.floor(lookbackDays))),
      target: ["variable", ["template-tag", "lookback_days"]],
    },
  ];
  const url = `${MB_BASE}/public/question/${PER_ENTITY_PUBLIC_UUID}.csv?parameters=${encodeURIComponent(JSON.stringify(params))}`;
  try {
    const res = await fetch(url, { headers: { Accept: "text/csv" }, cache: "no-store" });
    if (!res.ok) {
      console.warn(`[comms-bulk-fetch] per-entity csv HTTP ${res.status}`);
      return [];
    }
    const csv = await res.text();
    const parsed = Papa.parse<Record<string, string>>(csv, {
      header: true,
      skipEmptyLines: true,
    });
    return rowsToEvents(parsed.data || []);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[comms-bulk-fetch] per-entity csv failed: ${message}`);
    return [];
  }
}
