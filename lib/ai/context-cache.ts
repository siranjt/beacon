/**
 * Wave-3 (Beam/Keeper efficiency) — short-TTL in-memory cache for per-scope
 * context blobs.
 *
 * Beam's per-scope context loaders (Customer 360, customer-book, performance,
 * escalation, post-payment, etc.) re-fetch the same DB/Metabase/Chargebee
 * data every turn. The dominant traffic pattern is "AM asks 3-5 questions
 * in a row about the same customer" — the same context fully re-hydrates
 * on each invocation when the underlying data hasn't moved.
 *
 * This module is the simplest cache that beats that pattern: a process-
 * scoped Map keyed by an opaque string, 5min default TTL, no external
 * dependency. It accepts that:
 *   - cold-start Lambdas have an empty cache (regenerates on first hit)
 *   - multiple concurrent Lambdas see independent cache state
 *   - the cache is forgotten on deploy
 *
 * Those tradeoffs are acceptable because the hit-rate win during a hot
 * Lambda's lifespan is large: each per-scope context is on the order of
 * 100-500ms of I/O work. Caching turns the second and third turn into
 * near-zero-cost recalls.
 *
 * If we later need cross-Lambda or post-deploy persistence, we can layer
 * Redis or Postgres on top without changing the call site contract.
 */

export interface CacheOptions {
  /** TTL for this entry, in milliseconds. Default 5 minutes. */
  ttlMs?: number;
  /** If true, ignore an existing entry and call the loader. The fresh
   *  result still populates the cache so subsequent calls hit. Use this
   *  on the Refresh button path. */
  bypassCache?: boolean;
}

export interface CacheStats {
  /** Total getCachedContext calls since process start. */
  total_calls: number;
  /** Calls that returned a live cached value (no loader run). */
  hits: number;
  /** Calls that ran the loader (cold or expired). */
  misses: number;
  /** Calls where bypassCache forced a loader run. */
  bypasses: number;
  /** Current entry count. */
  entries: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Module-scoped singleton — survives across Lambda invocations within the
// same warm instance. Keyed by an opaque string the caller composes (see
// makeCacheKey below for the recommended shape).
const _cache = new Map<string, CacheEntry<unknown>>();

const _stats: CacheStats = {
  total_calls: 0,
  hits: 0,
  misses: 0,
  bypasses: 0,
  entries: 0,
};

/**
 * Memoize an async loader behind a TTL cache. Subsequent calls with the
 * same key return the cached value until TTL expires.
 *
 * Two failure modes are deliberate:
 *   - If the loader throws on a cache miss, the error propagates AND
 *     nothing is cached. Next call retries cold.
 *   - If the cache itself somehow misbehaves (it shouldn't — Map is
 *     stable), we still call the loader. Cache is best-effort.
 */
export async function getCachedContext<T>(
  key: string,
  loader: () => Promise<T>,
  opts: CacheOptions = {},
): Promise<T> {
  _stats.total_calls += 1;

  const now = Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  if (!opts.bypassCache) {
    const existing = _cache.get(key) as CacheEntry<T> | undefined;
    if (existing && existing.expiresAt > now) {
      _stats.hits += 1;
      return existing.value;
    }
  } else {
    _stats.bypasses += 1;
  }

  _stats.misses += 1;
  const value = await loader();
  _cache.set(key, { value, expiresAt: now + ttlMs });
  _stats.entries = _cache.size;
  return value;
}

/**
 * Remove a single entry. Caller fires this after a write that invalidates
 * the cached blob (e.g., new snapshot lands → bust customer-360 caches).
 */
export function invalidate(key: string): boolean {
  const had = _cache.delete(key);
  _stats.entries = _cache.size;
  return had;
}

/**
 * Remove every entry whose key starts with `prefix`. Useful when a refresh
 * lands new data and you want to bust an entire scope's cache without
 * enumerating each customer.
 *
 * Returns the count of entries removed.
 */
export function invalidatePrefix(prefix: string): number {
  let removed = 0;
  for (const k of Array.from(_cache.keys())) {
    if (k.startsWith(prefix)) {
      _cache.delete(k);
      removed += 1;
    }
  }
  _stats.entries = _cache.size;
  return removed;
}

/**
 * Drop every entry. Used by the global Refresh button when an AM wants to
 * force-recompute everything in this process. Test code also uses this
 * between cases.
 */
export function clearCache(): void {
  _cache.clear();
  _stats.entries = 0;
}

/**
 * Read-only stats snapshot for observability + tests. Mutating the
 * returned object does NOT change internal state.
 */
export function getCacheStats(): CacheStats {
  return { ..._stats };
}

/**
 * Reset cache + stats. Test-only — production should never call this.
 * Exported so vitest can isolate cases.
 */
export function _resetForTests(): void {
  _cache.clear();
  _stats.total_calls = 0;
  _stats.hits = 0;
  _stats.misses = 0;
  _stats.bypasses = 0;
  _stats.entries = 0;
}

/**
 * Wave-3 — high-level convenience: drop every Beam-loader cache entry
 * for the data-bearing scopes (customer-360, customer-book, post-payment).
 * Called from refresh.ts once a new snapshot lands so the next Beam
 * invocation sees fresh data rather than waiting out the TTL.
 *
 * Other scopes (inbox, performance, escalation, post-payment customer
 * page, miss-payment, negative-keyword) aren't wrapped yet — when they
 * get wrapped, add their prefixes here too.
 *
 * Returns the total entry count removed (across all prefixes).
 */
export function invalidateBeamContextCaches(): number {
  let removed = 0;
  removed += invalidatePrefix("customer-360");
  removed += invalidatePrefix("customer-book");
  removed += invalidatePrefix("post-payment-book");
  return removed;
}

/**
 * Recommended key shape: scope-first, then identifying fields, ending
 * with the role (so admin/manager/AM don't accidentally share entries
 * when their views of the same scope differ).
 *
 *   customer-360:entity=abc12345:role=am
 *   customer-book:am=sudha.g@zoca.com:role=am
 *   performance:entity=abc12345:role=manager
 *
 * Use the helper below instead of hand-composing strings — keeps the
 * prefix structure stable for invalidatePrefix.
 */
export function makeCacheKey(
  scope: string,
  fields: Record<string, string | number | null | undefined>,
): string {
  const sortedKeys = Object.keys(fields).sort();
  const parts: string[] = [scope];
  for (const k of sortedKeys) {
    const v = fields[k];
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${k}=${v}`);
  }
  return parts.join(":");
}
