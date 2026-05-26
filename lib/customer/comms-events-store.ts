/**
 * Phase E-19 Wave 1 — comms_events store.
 *
 * Operational cache layer between Metabase (system of record) and the rest of
 * Beacon (hot reads). Three responsibilities:
 *
 *   1. upsertCommsEvents(events)
 *      Idempotent bulk upsert. Stage B writes the bulk-events fetch into this.
 *      ON CONFLICT (entity_id, channel, source_id) DO UPDATE — re-runs of
 *      overlapping windows refresh the row instead of duplicating.
 *
 *   2. getEventsForEntity(entity_id, lookbackDays)
 *      Per-entity timeline read. Used by anything that needs the event list
 *      itself — customer cards' "last 5 touches" chip, AskPanel context
 *      loader, narrative compose layer. NOT used by the 360 timeline drill
 *      down (which still hits Metabase live for message bodies).
 *
 *   3. deriveCustomerMetricsFromEvents(events)
 *      Pure function — given an event list, produces a CustomerMetrics value
 *      compatible with what Stage B's 5-CSV path produces today. This is the
 *      load-bearing function for V1→V2 parity. The parity harness diffs
 *      Stage B's current output against the output of this function fed the
 *      same time window.
 *
 *   4. writeWatermark / readWatermark
 *      Per-entity ingestion watermark. Stage B writes it after upsert.
 *      UI freshness banners read it.
 *
 * The store NEVER calls Metabase. The fetcher (comms-bulk-fetch.ts) does
 * that; the store only knows about Postgres. This separation is on purpose
 * — it makes the store unit-testable and lets us swap the fetcher
 * implementation (Dataset API → raw SQL → other source) without touching
 * the consumer surface.
 */

import { getSql } from "./postgres";
import type { CustomerMetrics } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommsChannel = "chat" | "email" | "phone" | "sms" | "video";
export type CommsDirection = "inbound" | "outbound" | "system";

/**
 * Renamed from CommsEvent to avoid clash with the slim type in types.ts
 * that the existing 5-CSV path uses. Once the V1 path is retired in
 * Wave 3, the slim type can be deleted and this can take the name.
 */
export interface CommsEventRow {
  entity_id: string;
  channel: CommsChannel;
  source_id: string;
  direction: CommsDirection;
  subtype: string | null;
  sender_name: string | null;
  body_available: boolean;
  /** ISO8601 timestamptz. */
  created_at: string;
}

export interface CommsWatermark {
  entity_id: string;
  last_ingested_at: string;
  last_event_at: string | null;
  event_count_90d: number;
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

/**
 * Bulk upsert. Chunks of 1000 to stay under Neon's parameter limit. Returns
 * the count of distinct (entity, channel, source_id) tuples written —
 * useful for Stage B health logs.
 *
 * Caller is responsible for ensuring events have valid source_id and
 * non-null required fields. Anything missing source_id is dropped with a
 * warning (the bulk SQL's ROW_NUMBER dedup should never emit such a row,
 * but we belt-and-braces it).
 */
export async function upsertCommsEvents(
  events: CommsEventRow[],
): Promise<{ written: number; skipped: number }> {
  const sql = getSql();
  if (!sql) {
    console.warn("[comms-events-store] POSTGRES_URL not set — skipping upsert");
    return { written: 0, skipped: events.length };
  }

  // Drop events with missing required fields, AND dedupe within the input
  // by (entity_id, channel, source_id) — Postgres ON CONFLICT DO UPDATE
  // forbids the same conflict-key tuple appearing twice in a single INSERT.
  //
  // Why duplicates exist: the bulk-events Metabase question's ROW_NUMBER
  // dedup runs per (channel, direction, minute-bucket, source_id). If the
  // upstream channel tables emit the same source_id twice within different
  // minute buckets (possible for cross-system races, e.g. webhook + poll),
  // the SELECT returns both. Our PK is tighter — (entity, channel, sid) —
  // so we collapse to last-wins here. Until the SQL pushes its dedup to
  // the same key, this JS step is required.
  const dedup = new Map<string, CommsEventRow>();
  let skipped = 0;
  let dupesCollapsed = 0;
  for (const e of events) {
    if (!e.entity_id || !e.channel || !e.source_id || !e.created_at) {
      skipped++;
      continue;
    }
    const key = `${e.entity_id}::${e.channel}::${e.source_id}`;
    if (dedup.has(key)) dupesCollapsed++;
    dedup.set(key, e); // last-wins
  }
  const valid: CommsEventRow[] = Array.from(dedup.values());
  if (dupesCollapsed > 0) {
    console.warn(
      `[comms-events-store] collapsed ${dupesCollapsed} duplicate (entity,channel,source_id) tuples before upsert`,
    );
  }

  if (valid.length === 0) return { written: 0, skipped };

  // Chunk to keep statement size reasonable. Neon parameter limit ~ 65k;
  // we use 8 params/row × 1000 rows = 8000 params/chunk.
  const CHUNK = 1000;
  let written = 0;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const slice = valid.slice(i, i + CHUNK);

    // Build a VALUES list dynamically. neon's tagged template doesn't
    // natively support row-tuple expansion, so we construct positional
    // params manually.
    const values: unknown[] = [];
    const tuples: string[] = [];
    let p = 1;
    for (const e of slice) {
      tuples.push(
        `($${p++}::uuid, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::timestamptz)`,
      );
      values.push(
        e.entity_id,
        e.channel,
        e.source_id,
        e.direction,
        e.subtype,
        e.sender_name,
        e.body_available,
        e.created_at,
      );
    }

    const stmt = `
      INSERT INTO comms_events
        (entity_id, channel, source_id, direction, subtype, sender_name, body_available, created_at)
      VALUES ${tuples.join(",")}
      ON CONFLICT (entity_id, channel, source_id) DO UPDATE SET
        direction      = EXCLUDED.direction,
        subtype        = EXCLUDED.subtype,
        sender_name    = EXCLUDED.sender_name,
        body_available = EXCLUDED.body_available,
        created_at     = EXCLUDED.created_at,
        ingested_at    = NOW()
    `;
    // neon's tagged template supports raw query via .query() on the
    // unsafe path. Use the function form to pass parameters positionally.
    // Neon exports a `neon(url)` callable; the returned function accepts
    // string + params for parameterized queries.
    await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown>)(
      stmt,
      values,
    );
    written += slice.length;
  }

  return { written, skipped };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getEventsForEntity(
  entity_id: string,
  lookbackDays = 90,
): Promise<CommsEventRow[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = (await sql`
    SELECT entity_id, channel, source_id, direction, subtype, sender_name,
           body_available, created_at
    FROM comms_events
    WHERE entity_id = ${entity_id}::uuid
      AND created_at >= NOW() - (${lookbackDays}::int || ' days')::interval
    ORDER BY created_at DESC
  `) as Array<{
    entity_id: string;
    channel: CommsChannel;
    source_id: string;
    direction: CommsDirection;
    subtype: string | null;
    sender_name: string | null;
    body_available: boolean;
    created_at: string;
  }>;
  return rows.map((r) => ({
    entity_id: r.entity_id,
    channel: r.channel,
    source_id: r.source_id,
    direction: r.direction,
    subtype: r.subtype,
    sender_name: r.sender_name,
    body_available: r.body_available,
    created_at: r.created_at,
  }));
}

/**
 * Bulk read for Stage B's compose layer — pull events for many entities at
 * once. Returns a Map keyed by entity_id.
 */
export async function getEventsForEntities(
  entity_ids: string[],
  lookbackDays = 90,
): Promise<Map<string, CommsEventRow[]>> {
  const out = new Map<string, CommsEventRow[]>();
  for (const eid of entity_ids) out.set(eid, []);
  const sql = getSql();
  if (!sql || entity_ids.length === 0) return out;

  const rows = (await sql`
    SELECT entity_id, channel, source_id, direction, subtype, sender_name,
           body_available, created_at
    FROM comms_events
    WHERE entity_id = ANY(${entity_ids}::uuid[])
      AND created_at >= NOW() - (${lookbackDays}::int || ' days')::interval
    ORDER BY entity_id, created_at DESC
  `) as Array<{
    entity_id: string;
    channel: CommsChannel;
    source_id: string;
    direction: CommsDirection;
    subtype: string | null;
    sender_name: string | null;
    body_available: boolean;
    created_at: string;
  }>;

  for (const r of rows) {
    const arr = out.get(r.entity_id) || [];
    arr.push({
      entity_id: r.entity_id,
      channel: r.channel,
      source_id: r.source_id,
      direction: r.direction,
      subtype: r.subtype,
      sender_name: r.sender_name,
      body_available: r.body_available,
      created_at: r.created_at,
    });
    out.set(r.entity_id, arr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derivation — CustomerMetrics from events
// ---------------------------------------------------------------------------

/**
 * Pure function: given an entity's event list (sorted any order), produce
 * the same CustomerMetrics shape Stage B's 5-CSV path produces today.
 *
 * Bucket definitions (must match the V1 path, otherwise parity fails):
 *   - total_*d / in_*d / out_*d counts events with created_at >= now - Nd
 *   - channels_*d counts DISTINCT channel
 *   - channels_used_*d is "chat, email, phone" comma-joined sorted
 *   - last_any/in/out_iso: most recent created_at across all events,
 *     filtered by direction for in/out variants
 *   - days_since_in / days_since_out: floor((now - last) / 86400_000),
 *     999 when never observed
 */
export function deriveCustomerMetricsFromEvents(
  events: CommsEventRow[],
  now: Date = new Date(),
): CustomerMetrics {
  const nowMs = now.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const windows = [7, 14, 30, 60, 90];

  // Per-window accumulators
  const acc: Record<number, { total: number; in_: number; out: number; channels: Set<string> }> = {};
  for (const w of windows) {
    acc[w] = { total: 0, in_: 0, out: 0, channels: new Set() };
  }

  let last_any = -Infinity;
  let last_in = -Infinity;
  let last_out = -Infinity;

  for (const e of events) {
    const t = Date.parse(e.created_at);
    if (!Number.isFinite(t)) continue;
    const ageMs = nowMs - t;
    if (ageMs < 0) continue;        // future events ignored
    if (ageMs > 90 * dayMs) continue; // outside our widest window

    if (t > last_any) last_any = t;
    if (e.direction === "inbound" && t > last_in) last_in = t;
    if (e.direction === "outbound" && t > last_out) last_out = t;

    for (const w of windows) {
      if (ageMs <= w * dayMs) {
        const a = acc[w];
        a.total++;
        if (e.direction === "inbound") a.in_++;
        else if (e.direction === "outbound") a.out++;
        a.channels.add(e.channel);
      }
    }
  }

  const fmtChannels = (s: Set<string>): string => Array.from(s).sort().join(", ");
  const daysSince = (last: number): number => {
    if (!Number.isFinite(last)) return 999;
    return Math.max(0, Math.floor((nowMs - last) / dayMs));
  };
  const iso = (t: number): string | null =>
    Number.isFinite(t) ? new Date(t).toISOString() : null;

  return {
    total_7d: acc[7].total,  in_7d: acc[7].in_,  out_7d: acc[7].out,  channels_7d: acc[7].channels.size,
    total_14d: acc[14].total, in_14d: acc[14].in_, out_14d: acc[14].out, channels_14d: acc[14].channels.size,
    total_30d: acc[30].total, in_30d: acc[30].in_, out_30d: acc[30].out, channels_30d: acc[30].channels.size,
    total_60d: acc[60].total, in_60d: acc[60].in_, out_60d: acc[60].out, channels_60d: acc[60].channels.size,
    total_90d: acc[90].total, in_90d: acc[90].in_, out_90d: acc[90].out, channels_90d: acc[90].channels.size,
    channels_used_30d: fmtChannels(acc[30].channels),
    channels_used_90d: fmtChannels(acc[90].channels),
    last_any_iso: iso(last_any),
    last_in_iso: iso(last_in),
    last_out_iso: iso(last_out),
    days_since_in: daysSince(last_in),
    days_since_out: daysSince(last_out),
  };
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

export async function writeWatermarks(
  watermarks: Array<{
    entity_id: string;
    last_event_at: string | null;
    event_count_90d: number;
  }>,
): Promise<void> {
  const sql = getSql();
  if (!sql || watermarks.length === 0) return;

  const values: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  for (const w of watermarks) {
    tuples.push(`($${p++}::uuid, NOW(), $${p++}::timestamptz, $${p++}::int)`);
    values.push(w.entity_id, w.last_event_at, w.event_count_90d);
  }
  const stmt = `
    INSERT INTO comms_events_watermark
      (entity_id, last_ingested_at, last_event_at, event_count_90d)
    VALUES ${tuples.join(",")}
    ON CONFLICT (entity_id) DO UPDATE SET
      last_ingested_at = NOW(),
      last_event_at    = EXCLUDED.last_event_at,
      event_count_90d  = EXCLUDED.event_count_90d
  `;
  await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown>)(stmt, values);
}

export async function readWatermark(entity_id: string): Promise<CommsWatermark | null> {
  const sql = getSql();
  if (!sql) return null;
  const rows = (await sql`
    SELECT entity_id, last_ingested_at, last_event_at, event_count_90d
    FROM comms_events_watermark
    WHERE entity_id = ${entity_id}::uuid
  `) as Array<CommsWatermark>;
  return rows[0] || null;
}
