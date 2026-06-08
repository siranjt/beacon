/**
 * Negative Keyword Beacon — per-entity comms feed adapter. Phase NK-2.2.
 *
 * Wraps `lib/customer/comms-feed-v2.ts`'s `fetchCommsFeed()` and maps its
 * CommsFeedRow shape onto the NK-domain `CandidateMessage`. Single call
 * per entity_id; the upstream Metabase question already unions all 5
 * channels in one return.
 *
 * Why this thin adapter instead of calling fetchCommsFeed directly from
 * the cron: keeps the NK lib namespace self-contained. If we ever want
 * to swap the source (e.g. once `comms_events` is fully retired in the
 * per-entity decision from 2026-06-08), this is the one file to change.
 *
 * Window: 14 days (per NK_WINDOW_DAYS). The cron and the dashboard both
 * read the same window — anything older is out of scope.
 *
 * Soft-fail contract: any error → returns []. The cron logs the entity
 * id + error and keeps going; one customer's bad data shouldn't poison
 * the whole run.
 */

import { fetchCommsFeed } from "@/lib/customer/comms-feed-v2";
import type { CommsFeedRow } from "@/lib/customer/comms-feed-v2";
import {
  CHANNEL_TO_SOURCE,
  NK_WINDOW_DAYS,
  type CandidateMessage,
} from "./types";

/**
 * Fetch 14 days of comms for one entity and map to NK-shape candidates.
 *
 * @param entityId UUID. Empty/missing returns [].
 * @returns Array of CandidateMessage sorted newest-first.
 */
export async function fetchEntityCandidates(
  entityId: string,
): Promise<CandidateMessage[]> {
  if (!entityId) return [];

  let rows: CommsFeedRow[] = [];
  try {
    rows = await fetchCommsFeed(entityId, NK_WINDOW_DAYS);
  } catch (e) {
    console.warn(
      `[nk/feeds] fetchCommsFeed threw for ${entityId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return [];
  }

  return rows.map((r) => mapRow(r));
}

/** Pure mapper — exported for testability. */
export function mapRow(r: CommsFeedRow): CandidateMessage {
  const source = CHANNEL_TO_SOURCE[r.channel] ?? "App Chat"; // narrow channels — should never miss
  return {
    entity_id: r.entity_id,
    source,
    subtype: r.subtype,
    created_at: r.created_at,
    ts: r.ts,
    direction: r.direction,
    sender_name: r.sender_name,
    message_body: r.message_body,
    body_available: r.body_available,
    source_id: r.source_id,
  };
}
