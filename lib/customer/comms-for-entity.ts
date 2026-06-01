/**
 * Phase E-19 W2.5 — per-entity comms thread fetcher.
 *
 * This file used to pull 5 separate Metabase public CSVs in parallel and
 * filter rows by entity_id during parse. That approach is retired post-V2-
 * cutover: it duplicated the bulk Stage B path's failure modes (memory,
 * dedup, channel-mapping logic) at per-entity scale.
 *
 * Now this is a thin shim over `fetchCommsFeed` (which hits the per-entity
 * Metabase question via Dataset API). The EntityCommsEvent return shape
 * is preserved so the existing Customer 360 timeline route at
 * `/api/v2/customer/[entityId]/comms` keeps working without changes.
 *
 * Soft-fail behavior preserved: on any error we log a warning and return
 * `[]`. The detail page must never crash because comms are slow.
 */

import { fetchCommsFeed, type CommsFeedRow } from "./comms-feed-v2";

export type EntityCommsEvent = {
  ts: number;
  channel: "chat" | "email" | "phone" | "video" | "sms";
  direction: "in" | "out";
  body: string;
  sender: string;
  duration?: number;
};

/** Map V2's "inbound"/"outbound"/"system" to V1's "in"/"out" (system → out). */
function mapDirection(d: CommsFeedRow["direction"]): EntityCommsEvent["direction"] {
  if (d === "inbound") return "in";
  return "out";
}

/**
 * Fetch + filter per-entity comms over the last `daysBack` days. Returns
 * events sorted newest-first. Soft-fails to [] on any error.
 */
export async function fetchCommsForEntity(
  entityId: string,
  daysBack: number = 90,
): Promise<EntityCommsEvent[]> {
  if (!entityId) return [];
  const days = Math.max(1, Math.min(180, Math.floor(daysBack || 90)));

  try {
    const rows = await fetchCommsFeed(entityId, days);
    return rows.map((r) => ({
      ts: r.ts,
      channel: r.channel,
      direction: mapDirection(r.direction),
      body: r.message_body || "",
      sender: r.sender_name || "",
    }));
  } catch (e) {
    console.warn(
      `[fetchCommsForEntity] failed for ${entityId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return [];
  }
}
