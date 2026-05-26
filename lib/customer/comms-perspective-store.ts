/**
 * Phase E-18 — read / write helpers for the comms perspective cache.
 *
 * Backed by table `beacon_ai_comms_perspective` (see
 * `migrations/2026-05-26-beacon-ai-comms-perspective.sql`). One row per
 * (entity_id, snapshot_date).
 *
 * Two access patterns:
 *
 *   1. `readPerspective(entityId, date)` — pure cache read. Used in bulk
 *      passes (composeSnapshot, dashboard renders) where we MUST NOT
 *      trigger Haiku — that would push Vercel's function budget into
 *      overload. Returns null when the row doesn't exist; caller renders
 *      a neutral chip / skips the field.
 *
 *   2. `getOrCompute(entityId, date, opts)` — read-through cache. If the
 *      row exists and `forceRefresh` is false, return it. Otherwise fetch
 *      the comms feed, run Haiku, persist, return. This is the on-demand
 *      path the /api endpoint uses when an AM opens a customer detail.
 *
 * `writePerspective` is the UPSERT primitive; both paths funnel through it.
 *
 * Failure semantics:
 *   - Missing Postgres → no-op writes, neutral-fallback reads. Local dev
 *     without POSTGRES_URL stays functional.
 *   - SQL error → log + return null/neutral, never throw. This sits on
 *     hot paths (dashboard render, /api/customer/perspective) so we can't
 *     let it cascade.
 */
import { getSql } from "./postgres";
import { fetchCommsFeed } from "./comms-feed-v2";
import {
  buildCommsPerspective,
  neutralPerspective,
  type CommsPerspective,
} from "./comms-perspective";

const LOOKBACK_DAYS = 90;

export interface PerspectiveRow extends CommsPerspective {
  entity_id: string;
  snapshot_date: string;  // YYYY-MM-DD
  computed_at: string;    // ISO
}

interface RawRow {
  entity_id: string;
  snapshot_date: string;
  message_count: number;
  channel_mix: unknown;
  direction_mix: unknown;
  sentiment: string;
  sentiment_evidence: unknown;
  topics: string[];
  substance_score: number;
  initiator_pattern: string;
  response_latency_hours: number | string | null;
  conversation_arcs: unknown;
  haiku_summary: string;
  computed_at: string;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function castRow(raw: RawRow): PerspectiveRow {
  return {
    entity_id: raw.entity_id,
    snapshot_date: raw.snapshot_date,
    message_count: raw.message_count,
    channel_mix: raw.channel_mix as CommsPerspective["channel_mix"],
    direction_mix: raw.direction_mix as CommsPerspective["direction_mix"],
    sentiment: raw.sentiment as CommsPerspective["sentiment"],
    sentiment_evidence: (raw.sentiment_evidence ?? []) as CommsPerspective["sentiment_evidence"],
    topics: Array.isArray(raw.topics) ? raw.topics : [],
    substance_score: raw.substance_score,
    initiator_pattern: raw.initiator_pattern as CommsPerspective["initiator_pattern"],
    response_latency_hours:
      raw.response_latency_hours === null || raw.response_latency_hours === undefined
        ? null
        : Number(raw.response_latency_hours),
    conversation_arcs: (raw.conversation_arcs ?? []) as CommsPerspective["conversation_arcs"],
    haiku_summary: raw.haiku_summary,
    computed_at: raw.computed_at,
  };
}

/** Pure cache read. Never triggers Haiku. */
export async function readPerspective(
  entityId: string,
  date: string = todayUtc(),
): Promise<PerspectiveRow | null> {
  if (!entityId) return null;
  const sql = getSql();
  if (!sql) return null;
  try {
    const rows = await sql`
      SELECT
        entity_id::text         AS entity_id,
        snapshot_date::text     AS snapshot_date,
        message_count,
        channel_mix,
        direction_mix,
        sentiment,
        sentiment_evidence,
        topics,
        substance_score,
        initiator_pattern,
        response_latency_hours,
        conversation_arcs,
        haiku_summary,
        computed_at
        FROM beacon_ai_comms_perspective
       WHERE entity_id = ${entityId}::uuid
         AND snapshot_date = ${date}
       LIMIT 1
    `;
    const list = rows as unknown as RawRow[];
    if (list.length === 0) return null;
    return castRow(list[0]);
  } catch (err) {
    console.warn(
      "[comms-perspective-store.readPerspective]",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Read the most-recent perspective on or before `date`. Useful for the
 *  dashboard "yesterday's row is fine" fallback when today's Haiku hasn't
 *  been triggered yet. */
export async function readMostRecentPerspective(
  entityId: string,
  beforeDate: string = todayUtc(),
): Promise<PerspectiveRow | null> {
  if (!entityId) return null;
  const sql = getSql();
  if (!sql) return null;
  try {
    const rows = await sql`
      SELECT
        entity_id::text         AS entity_id,
        snapshot_date::text     AS snapshot_date,
        message_count,
        channel_mix,
        direction_mix,
        sentiment,
        sentiment_evidence,
        topics,
        substance_score,
        initiator_pattern,
        response_latency_hours,
        conversation_arcs,
        haiku_summary,
        computed_at
        FROM beacon_ai_comms_perspective
       WHERE entity_id = ${entityId}::uuid
         AND snapshot_date <= ${beforeDate}
       ORDER BY snapshot_date DESC
       LIMIT 1
    `;
    const list = rows as unknown as RawRow[];
    if (list.length === 0) return null;
    return castRow(list[0]);
  } catch (err) {
    console.warn(
      "[comms-perspective-store.readMostRecentPerspective]",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** UPSERT a perspective row. Caller owns the date; we don't infer. */
export async function writePerspective(
  entityId: string,
  date: string,
  payload: CommsPerspective,
): Promise<PerspectiveRow | null> {
  if (!entityId) return null;
  const sql = getSql();
  if (!sql) return null;
  try {
    const rows = await sql`
      INSERT INTO beacon_ai_comms_perspective (
        entity_id, snapshot_date,
        message_count, channel_mix, direction_mix,
        sentiment, sentiment_evidence, topics,
        substance_score, initiator_pattern, response_latency_hours,
        conversation_arcs, haiku_summary
      ) VALUES (
        ${entityId}::uuid, ${date},
        ${payload.message_count},
        ${JSON.stringify(payload.channel_mix)}::jsonb,
        ${JSON.stringify(payload.direction_mix)}::jsonb,
        ${payload.sentiment},
        ${JSON.stringify(payload.sentiment_evidence)}::jsonb,
        ${payload.topics as unknown as string[]},
        ${payload.substance_score},
        ${payload.initiator_pattern},
        ${payload.response_latency_hours},
        ${JSON.stringify(payload.conversation_arcs)}::jsonb,
        ${payload.haiku_summary}
      )
      ON CONFLICT (entity_id, snapshot_date) DO UPDATE SET
        message_count          = EXCLUDED.message_count,
        channel_mix            = EXCLUDED.channel_mix,
        direction_mix          = EXCLUDED.direction_mix,
        sentiment              = EXCLUDED.sentiment,
        sentiment_evidence     = EXCLUDED.sentiment_evidence,
        topics                 = EXCLUDED.topics,
        substance_score        = EXCLUDED.substance_score,
        initiator_pattern      = EXCLUDED.initiator_pattern,
        response_latency_hours = EXCLUDED.response_latency_hours,
        conversation_arcs      = EXCLUDED.conversation_arcs,
        haiku_summary          = EXCLUDED.haiku_summary,
        computed_at            = NOW()
      RETURNING
        entity_id::text         AS entity_id,
        snapshot_date::text     AS snapshot_date,
        message_count,
        channel_mix,
        direction_mix,
        sentiment,
        sentiment_evidence,
        topics,
        substance_score,
        initiator_pattern,
        response_latency_hours,
        conversation_arcs,
        haiku_summary,
        computed_at
    `;
    const list = rows as unknown as RawRow[];
    if (list.length === 0) return null;
    return castRow(list[0]);
  } catch (err) {
    console.warn(
      "[comms-perspective-store.writePerspective]",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export interface GetOrComputeOptions {
  /** Skip the cache + always recompute. Manager/admin only — guard at the
   *  route layer. */
  forceRefresh?: boolean;
  /** Lookback window in days. Defaults to 90; rarely overridden. */
  lookbackDays?: number;
}

/**
 * Read-through cache: returns today's row, computing + persisting if
 * missing. Soft-fails to a neutral, NON-persisted perspective so a dead
 * DB or dead Haiku doesn't break the caller. The neutral row reflects
 * counts we can derive locally.
 */
export async function getOrCompute(
  entityId: string,
  date: string = todayUtc(),
  opts: GetOrComputeOptions = {},
): Promise<PerspectiveRow | null> {
  if (!entityId) return null;
  if (!opts.forceRefresh) {
    const cached = await readPerspective(entityId, date);
    if (cached) return cached;
  }
  // Compute path — fetch feed → Haiku → persist.
  const rows = await fetchCommsFeed(entityId, opts.lookbackDays ?? LOOKBACK_DAYS);
  let payload: CommsPerspective;
  try {
    payload = await buildCommsPerspective(rows);
  } catch (err) {
    console.warn(
      "[comms-perspective-store.getOrCompute] buildCommsPerspective threw:",
      err instanceof Error ? err.message : String(err),
    );
    payload = neutralPerspective(rows);
  }
  const written = await writePerspective(entityId, date, payload);
  if (written) return written;
  // Couldn't persist — return an in-memory shape so the caller can still
  // render. snapshot_date / computed_at are best-effort.
  return {
    entity_id: entityId,
    snapshot_date: date,
    computed_at: new Date().toISOString(),
    ...payload,
  };
}

/**
 * Bulk cache read for many entities at once. Returns a `Map<entity_id,
 * PerspectiveRow>` containing only entities that DO have a row for the
 * given date — missing entries should be treated as "no perspective yet,
 * render skeleton chip". Never triggers Haiku.
 */
export async function readPerspectivesForEntities(
  entityIds: string[],
  date: string = todayUtc(),
): Promise<Map<string, PerspectiveRow>> {
  const out = new Map<string, PerspectiveRow>();
  if (entityIds.length === 0) return out;
  const sql = getSql();
  if (!sql) return out;
  try {
    const rows = await sql`
      SELECT
        entity_id::text         AS entity_id,
        snapshot_date::text     AS snapshot_date,
        message_count,
        channel_mix,
        direction_mix,
        sentiment,
        sentiment_evidence,
        topics,
        substance_score,
        initiator_pattern,
        response_latency_hours,
        conversation_arcs,
        haiku_summary,
        computed_at
        FROM beacon_ai_comms_perspective
       WHERE entity_id = ANY(${entityIds}::uuid[])
         AND snapshot_date = ${date}
    `;
    for (const raw of rows as unknown as RawRow[]) {
      out.set(raw.entity_id, castRow(raw));
    }
    return out;
  } catch (err) {
    console.warn(
      "[comms-perspective-store.readPerspectivesForEntities]",
      err instanceof Error ? err.message : String(err),
    );
    return out;
  }
}
