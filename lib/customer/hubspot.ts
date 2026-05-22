/**
 * HubSpot CRM v3 API client.
 *
 * Auth: Bearer HUBSPOT_ACCESS_TOKEN (Private App token, read-only scopes).
 * Falls back to empty data when the env var is unset — every downstream
 * caller sees a clean empty result and the dashboard runs normally.
 *
 * Defenses:
 * - 5s per-request timeout
 * - Exponential backoff retry on 429 (rate limit) and 5xx, max 3 attempts
 * - Caps pagination at 100 pages (10K records / page=100) per call to avoid runaways
 *
 * Rate limit: HubSpot Pro = 100 req / 10s, 250K / day. We use ~50-100/day.
 */

const HUBSPOT_BASE = "https://api.hubapi.com";

export function hubspotConfigured(): boolean {
  return !!process.env.HUBSPOT_ACCESS_TOKEN;
}

type FetchOpts = {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
};

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Single HTTP request with retry on 429 / 5xx. */
export async function hubspotFetch<T>(
  path: string,
  opts: FetchOpts = {},
): Promise<T | null> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return null;

  const url = path.startsWith("http") ? path : `${HUBSPOT_BASE}${path}`;
  const timeout = opts.timeoutMs ?? 5_000;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxAttempts) {
          const delayMs = 2 ** attempt * 500 + Math.random() * 200;
          await sleep(delayMs);
          continue;
        }
        const text = await res.text().catch(() => res.statusText);
        console.warn(
          `[hubspot] ${res.status} on ${path} (final attempt): ${text.slice(0, 200)}`,
        );
        return null;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        console.warn(`[hubspot] ${res.status} on ${path}: ${text.slice(0, 200)}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (e) {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[hubspot] fetch error on ${path} (attempt ${attempt}): ${msg}`);
      if (attempt < maxAttempts) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Paginate through a HubSpot search endpoint.
 * Caps at MAX_PAGES * 100 results.
 *
 * For /crm/v3/objects/{type}/search.
 *
 * The `body` argument is spread into every paginated request, so any
 * HubSpot-supported search field passes through transparently — notably
 * `filterGroups`, `properties`, `sorts`, and `associations` (used by
 * Phase 14.3's calls fetcher to expand associated companies inline).
 * Pagination (`limit` + `after`) is owned by this helper.
 */
type SearchResponse<T> = {
  total: number;
  results: T[];
  paging?: { next?: { after: string } };
};

const MAX_PAGES = 100;          // 10K records cap (sanity)
const PAGE_LIMIT = 100;          // HubSpot max page size

export async function hubspotSearchAll<T>(
  objectType: string,
  body: Record<string, unknown>,
): Promise<T[]> {
  if (!hubspotConfigured()) return [];
  const out: T[] = [];
  let after: string | undefined = undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const req: Record<string, unknown> = {
      ...body,
      limit: PAGE_LIMIT,
      ...(after ? { after } : {}),
    };
    const resp: SearchResponse<T> | null = await hubspotFetch<SearchResponse<T>>(
      `/crm/v3/objects/${objectType}/search`,
      { method: "POST", body: req, timeoutMs: 8_000 },
    );
    if (!resp || !resp.results) break;
    out.push(...resp.results);
    if (!resp.paging?.next?.after) break;
    after = resp.paging.next.after;
  }
  return out;
}

/**
 * Batch read by IDs — up to 100 per call. Multi-call wrapper auto-chunks.
 * Path: /crm/v3/objects/{type}/batch/read
 */
type BatchReadResponse<T> = {
  status: string;
  results: T[];
};

export async function hubspotBatchRead<T>(
  objectType: string,
  ids: (string | number)[],
  properties: string[],
): Promise<T[]> {
  if (!hubspotConfigured() || !ids.length) return [];
  const out: T[] = [];
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const resp = await hubspotFetch<BatchReadResponse<T>>(
      `/crm/v3/objects/${objectType}/batch/read`,
      {
        method: "POST",
        body: {
          inputs: chunk.map((id) => ({ id: String(id) })),
          properties,
        },
        timeoutMs: 8_000,
      },
    );
    if (resp?.results) out.push(...resp.results);
  }
  return out;
}

/**
 * Read associations for an object → list of associated IDs of another type.
 */
type AssociationsResponse = {
  results: Array<{
    from?: { id: string };
    to?: Array<{ toObjectId: number; associationTypes?: unknown }>;
  }>;
};

export async function hubspotBatchAssociations(
  fromObjectType: string,
  fromIds: (string | number)[],
  toObjectType: string,
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  if (!hubspotConfigured() || !fromIds.length) return map;
  const CHUNK = 100;
  for (let i = 0; i < fromIds.length; i += CHUNK) {
    const chunk = fromIds.slice(i, i + CHUNK);
    const resp = await hubspotFetch<AssociationsResponse>(
      `/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/read`,
      {
        method: "POST",
        body: { inputs: chunk.map((id) => ({ id: String(id) })) },
        timeoutMs: 8_000,
      },
    );
    if (!resp?.results) continue;
    for (const row of resp.results) {
      const fromId = row.from?.id;
      if (!fromId) continue;
      const toIds = (row.to || []).map((t) => t.toObjectId).filter((n) => Number.isFinite(n));
      map.set(fromId, toIds);
    }
  }
  return map;
}

/**
 * Lightweight ping — checks the token works.
 */
export async function hubspotPing(): Promise<{ ok: boolean; portalId?: number; error?: string }> {
  if (!hubspotConfigured()) {
    return { ok: false, error: "HUBSPOT_ACCESS_TOKEN not set" };
  }
  const resp = await hubspotFetch<{ portalId: number }>(
    "/account-info/v3/details",
    { timeoutMs: 4_000 },
  );
  if (!resp) return { ok: false, error: "no response" };
  return { ok: true, portalId: resp.portalId };
}
