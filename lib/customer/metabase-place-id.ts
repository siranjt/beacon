/**
 * Metabase Dataset API client — entity_id → place_id resolver.
 *
 * Phase 14.4: confirmed via Metabase that gbp.locations does NOT have a
 * flat place_id column. The place_id lives inside the metadata JSONB
 * (and only for ~33% of entities). The actual flat source is
 * local_seo.rank, which has both entity_id and place_id as columns
 * (multiple rows per entity, but DISTINCT gets us a clean mapping).
 *
 * Strategy: query local_seo.rank first (primary), then
 * gbp.locations.metadata->>'place_id' as fallback. Accumulate place_ids
 * from each table — don't return early; some entities live in one
 * table, others in the other. Dedup on entity_id (first match wins).
 *
 * Auth: `x-api-key: ${METABASE_API_KEY}`. When the env var is unset (the
 * common dev case until the key lands in Vercel), this module logs and
 * returns an empty Map — every downstream caller falls back to bizname
 * cleanly, matching the rest of the HubSpot stack's graceful-degrade
 * pattern.
 */

const METABASE_BASE = "https://metabase.zoca.ai";
const AURORA_DB_ID = 7;
const REQUEST_TIMEOUT_MS = 15_000;

const CANDIDATE_QUERIES = [
  {
    name: "local_seo.rank",
    sql: `
      SELECT DISTINCT entity_id, place_id
      FROM local_seo.rank
      WHERE entity_id = ANY('{__ENTITY_IDS__}'::uuid[])
        AND place_id IS NOT NULL
        AND place_id != ''
    `,
  },
  {
    name: "gbp.locations.metadata",
    sql: `
      SELECT entity_id, metadata->>'place_id' AS place_id
      FROM gbp.locations
      WHERE entity_id = ANY('{__ENTITY_IDS__}'::uuid[])
        AND metadata->>'place_id' IS NOT NULL
        AND metadata->>'place_id' != ''
    `,
  },
];

export function metabaseDatasetApiConfigured(): boolean {
  return !!process.env.METABASE_API_KEY;
}

type DatasetResponseRow = Record<string, unknown>;

type DatasetResponse = {
  data?: {
    rows?: unknown[][];
    cols?: Array<{ name: string }>;
  };
  error?: string;
};

/**
 * Run a parameterized native SQL query against a Metabase database.
 * Returns an array of row objects keyed by column name (Metabase ships
 * back rows-of-arrays plus a cols array, so we re-shape here).
 *
 * Errors are converted to console warnings + empty result — callers must
 * never crash the snapshot pipeline because the optional Dataset API is
 * down.
 */
async function runDatasetQuery(args: {
  database: number;
  sql: string;
  templateTags?: Record<string, unknown>;
  parameters?: Array<Record<string, unknown>>;
}): Promise<DatasetResponseRow[]> {
  const apiKey = process.env.METABASE_API_KEY;
  if (!apiKey) {
    console.log("[metabase-dataset] METABASE_API_KEY not set — skipping query");
    return [];
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${METABASE_BASE}/api/dataset`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        Accept: "application/json",
      },
      body: JSON.stringify({
        database: args.database,
        type: "native",
        native: {
          query: args.sql,
          "template-tags": args.templateTags ?? {},
        },
        parameters: args.parameters ?? [],
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      console.warn(`[metabase-dataset] ${res.status}: ${text.slice(0, 200)}`);
      return [];
    }
    const json = (await res.json()) as DatasetResponse;
    if (json.error) {
      console.warn(`[metabase-dataset] error: ${String(json.error).slice(0, 200)}`);
      return [];
    }
    const rows = json.data?.rows ?? [];
    const cols = (json.data?.cols ?? []).map((c) => c.name);
    return rows.map((row) => {
      const obj: DatasetResponseRow = {};
      for (let i = 0; i < cols.length; i += 1) {
        obj[cols[i]] = (row as unknown[])[i];
      }
      return obj;
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[metabase-dataset] fetch error: ${msg}`);
    return [];
  }
}

/**
 * Resolve a list of entity_ids -> place_ids via Aurora.
 *
 * Phase 14.4: queries local_seo.rank first (primary; has flat columns
 * for entity_id and place_id), then gbp.locations.metadata->>'place_id'
 * as fallback for entities only available there. Per-query row counts
 * are logged. Entity_ids are UUIDs from trusted internal callers so
 * direct interpolation is safe; the ::uuid[] cast validates them at
 * query time.
 *
 * Returns a Map keyed by entity_id. Entities without a place_id (no GBP
 * connected yet) are simply absent from the Map — callers should treat
 * missing keys as "fall back to bizname join."
 */
export async function fetchPlaceIdsForEntities(
  entityIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!entityIds.length) return out;
  if (!process.env.METABASE_API_KEY) {
    console.warn(
      "[metabase-place-id] METABASE_API_KEY not set — place_id join will silently no-op. Set env var on Vercel to enable.",
    );
    return out;
  }

  for (const { name, sql: template } of CANDIDATE_QUERIES) {
    const sql = template.replace("__ENTITY_IDS__", entityIds.join(","));
    try {
      const rows = await runDatasetQuery({ database: AURORA_DB_ID, sql });
      let added = 0;
      for (const r of rows) {
        const eid = String(r.entity_id || "").trim();
        const pid = String(r.place_id || "").trim();
        if (eid && pid && !out.has(eid)) {
          out.set(eid, pid);
          added += 1;
        }
      }
      console.log(
        `[metabase-place-id] ${name} → ${added} new place_ids (running total: ${out.size}/${entityIds.length})`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[metabase-place-id] ${name} failed: ${msg}`);
    }
  }

  if (out.size === 0) {
    console.warn(
      `[metabase-place-id] no table returned place_ids for ${entityIds.length} entity_ids`,
    );
  }
  return out;
}
