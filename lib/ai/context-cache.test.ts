/**
 * Wave-3 (context cache) — unit tests.
 *
 * Covers hit/miss/expiration/invalidation semantics + the recommended
 * key shape from makeCacheKey. The wrapped loaders (loadCustomer360Context
 * etc.) are exercised in the manual smoke run, not here — they need DB +
 * external APIs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedContext,
  invalidate,
  invalidatePrefix,
  invalidateBeamContextCaches,
  clearCache,
  getCacheStats,
  makeCacheKey,
  _resetForTests,
} from "./context-cache";

beforeEach(() => {
  _resetForTests();
});

describe("getCachedContext — hit / miss / expiry", () => {
  it("calls the loader on a cold miss and caches the result", async () => {
    let callCount = 0;
    const result = await getCachedContext("k1", async () => {
      callCount += 1;
      return { value: 42 };
    });
    expect(result).toEqual({ value: 42 });
    expect(callCount).toBe(1);
    const stats = getCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
    expect(stats.entries).toBe(1);
  });

  it("returns the cached value without calling the loader on a hot hit", async () => {
    let callCount = 0;
    const loader = async () => {
      callCount += 1;
      return { value: "first" };
    };
    await getCachedContext("k1", loader);
    const r2 = await getCachedContext("k1", loader);
    expect(r2).toEqual({ value: "first" });
    expect(callCount).toBe(1); // loader only ran on first call
    const stats = getCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.total_calls).toBe(2);
  });

  it("returns separate values for distinct keys", async () => {
    const a = await getCachedContext("a", async () => "alpha");
    const b = await getCachedContext("b", async () => "beta");
    expect(a).toBe("alpha");
    expect(b).toBe("beta");
    expect(getCacheStats().entries).toBe(2);
  });

  it("respects a short ttlMs — re-runs loader after expiration", async () => {
    let callCount = 0;
    const loader = async () => {
      callCount += 1;
      return callCount;
    };
    await getCachedContext("k1", loader, { ttlMs: 5 });
    // Wait past the TTL.
    await new Promise((r) => setTimeout(r, 15));
    const r2 = await getCachedContext("k1", loader, { ttlMs: 5 });
    expect(callCount).toBe(2);
    expect(r2).toBe(2);
  });

  it("bypassCache forces a fresh loader run and refreshes the cache", async () => {
    let callCount = 0;
    const loader = async () => {
      callCount += 1;
      return callCount;
    };
    await getCachedContext("k1", loader);
    const r2 = await getCachedContext("k1", loader, { bypassCache: true });
    expect(callCount).toBe(2);
    expect(r2).toBe(2);
    // Next call should now hit the refreshed cache, not run again.
    const r3 = await getCachedContext("k1", loader);
    expect(callCount).toBe(2);
    expect(r3).toBe(2);
    const stats = getCacheStats();
    expect(stats.bypasses).toBe(1);
  });

  it("propagates loader errors without caching", async () => {
    await expect(
      getCachedContext("k1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // No entry written.
    expect(getCacheStats().entries).toBe(0);
    // Next call retries — error not cached.
    const result = await getCachedContext("k1", async () => "ok");
    expect(result).toBe("ok");
  });
});

describe("invalidation", () => {
  it("invalidate(key) drops a single entry", async () => {
    await getCachedContext("k1", async () => "v1");
    expect(getCacheStats().entries).toBe(1);
    const dropped = invalidate("k1");
    expect(dropped).toBe(true);
    expect(getCacheStats().entries).toBe(0);
  });

  it("invalidate returns false when nothing to drop", () => {
    expect(invalidate("nonexistent")).toBe(false);
  });

  it("invalidatePrefix drops every entry under a prefix", async () => {
    await getCachedContext("customer-360:entity_id=abc", async () => 1);
    await getCachedContext("customer-360:entity_id=def", async () => 2);
    await getCachedContext("customer-book:am=jane", async () => 3);
    const dropped = invalidatePrefix("customer-360");
    expect(dropped).toBe(2);
    expect(getCacheStats().entries).toBe(1);
    // The other-scope entry survives.
    const survivor = await getCachedContext("customer-book:am=jane", async () => 99);
    expect(survivor).toBe(3); // still cached
  });

  it("invalidateBeamContextCaches drops the data-bearing scopes", async () => {
    await getCachedContext("customer-360:entity_id=abc", async () => 1);
    await getCachedContext("customer-book:am=jane", async () => 2);
    await getCachedContext("post-payment-book:", async () => 3);
    await getCachedContext("unrelated-scope:foo", async () => 4);
    const dropped = invalidateBeamContextCaches();
    expect(dropped).toBe(3);
    expect(getCacheStats().entries).toBe(1);
  });

  it("clearCache drops everything", async () => {
    await getCachedContext("a", async () => 1);
    await getCachedContext("b", async () => 2);
    clearCache();
    expect(getCacheStats().entries).toBe(0);
  });
});

describe("makeCacheKey — recommended key shape", () => {
  it("composes scope + fields into a stable colon-delimited string", () => {
    const k = makeCacheKey("customer-360", { entity_id: "abc12345" });
    expect(k).toBe("customer-360:entity_id=abc12345");
  });

  it("sorts fields alphabetically for stability across call sites", () => {
    const k1 = makeCacheKey("scope", { b: "2", a: "1", c: "3" });
    const k2 = makeCacheKey("scope", { c: "3", a: "1", b: "2" });
    expect(k1).toBe(k2);
    expect(k1).toBe("scope:a=1:b=2:c=3");
  });

  it("skips null / undefined / empty-string fields", () => {
    const k = makeCacheKey("scope", {
      a: "1",
      b: null,
      c: undefined,
      d: "",
      e: "5",
    });
    expect(k).toBe("scope:a=1:e=5");
  });

  it("accepts numeric values without coercion", () => {
    const k = makeCacheKey("scope", { count: 42 });
    expect(k).toBe("scope:count=42");
  });

  it("returns just the scope when no fields apply", () => {
    expect(makeCacheKey("scope", {})).toBe("scope");
    expect(makeCacheKey("scope", { a: null })).toBe("scope");
  });

  it("the resulting key is invalidatePrefix-friendly by scope", async () => {
    const k1 = makeCacheKey("customer-360", { entity_id: "abc" });
    const k2 = makeCacheKey("customer-360", { entity_id: "def" });
    await getCachedContext(k1, async () => 1);
    await getCachedContext(k2, async () => 2);
    expect(invalidatePrefix("customer-360")).toBe(2);
  });
});
