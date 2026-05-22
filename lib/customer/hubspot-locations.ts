// Phase 33.D — HubSpot Locations sync + getter.
//
// Two responsibilities:
//   1. syncAllLocations() — paginated fetch of every Location record from
//      HubSpot's CRM API, requesting `location_entity_id`, `name`, `place_id`.
//      Upserts each row into `hubspot_location_mapping` keyed by entity_id.
//   2. getLocationRecordIdMap() — fast lookup; returns
//      Map<entity_id, location_record_id> read from Postgres.
//
// Token: HUBSPOT_ACCESS_TOKEN env var (Phase 33.D.1 — confirmed against the
// existing Vercel env var name). HUBSPOT_API_KEY + HUBSPOT_PRIVATE_APP_TOKEN
// are also accepted as fallbacks in case the var gets renamed in the future.

import { getSql } from "@/lib/customer/postgres";
import {
  HUBSPOT_LOCATIONS_OBJECT_ID,
  HUBSPOT_LOCATION_ENTITY_ID_PROPERTY,
} from "@/lib/customer/hubspot-config";

const BASE = "https://api.hubapi.com";

function getToken(): string | null {
  // Phase 33.D.1 — HUBSPOT_ACCESS_TOKEN is the canonical name in Vercel.
  // The other two are kept as fallbacks for env-var renames or local dev.
  return (
    process.env.HUBSPOT_ACCESS_TOKEN ||
    process.env.HUBSPOT_API_KEY ||
    process.env.HUBSPOT_PRIVATE_APP_TOKEN ||
    null
  );
}

interface HubspotLocationRecord {
  id: string;
  properties: {
    name?: string;
    location_entity_id?: string;
    place_id?: string;
  };
}

interface HubspotListResponse {
  results: HubspotLocationRecord[];
  paging?: {
    next?: { after: string };
  };
}

/**
 * Fetch every HubSpot Location record. Paginates 100 at a time. Returns the
 * full array — typical volume is ~1.5K-2K records, well within memory.
 */
export async function fetchAllLocations(): Promise<HubspotLocationRecord[]> {
  const token = getToken();
  if (!token) {
    throw new Error(
      "[hubspot-locations] HUBSPOT_ACCESS_TOKEN / HUBSPOT_API_KEY / HUBSPOT_PRIVATE_APP_TOKEN not set",
    );
  }

  const all: HubspotLocationRecord[] = [];
  let after: string | undefined = undefined;
  let pageNumber = 0;
  const MAX_PAGES = 100; // 100 * 100 = 10K records — well above today's volume

  while (pageNumber < MAX_PAGES) {
    pageNumber++;
    const params = new URLSearchParams({
      limit: "100",
      properties: `name,${HUBSPOT_LOCATION_ENTITY_ID_PROPERTY},place_id`,
    });
    if (after) params.set("after", after);

    const url = `${BASE}/crm/v3/objects/${HUBSPOT_LOCATIONS_OBJECT_ID}?${params.toString()}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => res.statusText);
      throw new Error(
        `[hubspot-locations] HubSpot API ${res.status}: ${txt.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as HubspotListResponse;
    all.push(...(data.results || []));

    if (data.paging?.next?.after) {
      after = data.paging.next.after;
    } else {
      break;
    }
  }

  return all;
}

export interface SyncStats {
  fetched: number;
  upserted: number;
  skipped_no_entity_id: number;
  skipped_invalid_uuid: number;
  durationMs: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pull all locations from HubSpot, write each (entity_id, location_record_id)
 * pair to Postgres. Idempotent — re-runs upsert by entity_id.
 */
export async function syncAllLocations(): Promise<SyncStats> {
  const startedAt = Date.now();
  const sql = getSql();
  if (!sql) {
    throw new Error("[hubspot-locations] POSTGRES_URL not configured");
  }

  const records = await fetchAllLocations();
  const stats: SyncStats = {
    fetched: records.length,
    upserted: 0,
    skipped_no_entity_id: 0,
    skipped_invalid_uuid: 0,
    durationMs: 0,
  };

  for (const r of records) {
    const eid = (r.properties.location_entity_id || "").trim().toLowerCase();
    if (!eid) {
      stats.skipped_no_entity_id++;
      continue;
    }
    if (!UUID_RE.test(eid)) {
      stats.skipped_invalid_uuid++;
      continue;
    }

    await sql`
      INSERT INTO hubspot_location_mapping
        (entity_id, location_record_id, bizname, place_id, synced_at)
      VALUES
        (${eid}::uuid, ${r.id}, ${r.properties.name ?? null}, ${r.properties.place_id ?? null}, NOW())
      ON CONFLICT (entity_id) DO UPDATE SET
        location_record_id = EXCLUDED.location_record_id,
        bizname            = EXCLUDED.bizname,
        place_id           = EXCLUDED.place_id,
        synced_at          = NOW()
    `;
    stats.upserted++;
  }

  stats.durationMs = Date.now() - startedAt;
  return stats;
}

/**
 * Returns a fresh Map<entity_id, location_record_id> read from Postgres.
 * Used by the snapshot compose step to enrich customer rows with their
 * HubSpot Locations record id.
 */
export async function getLocationRecordIdMap(): Promise<Map<string, string>> {
  const sql = getSql();
  if (!sql) return new Map();

  const rows = await sql`
    SELECT entity_id::text AS entity_id, location_record_id
    FROM hubspot_location_mapping
  `;
  const m = new Map<string, string>();
  for (const r of rows as Array<{ entity_id: string; location_record_id: string }>) {
    m.set(r.entity_id.toLowerCase(), r.location_record_id);
  }
  return m;
}
