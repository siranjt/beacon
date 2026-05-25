/**
 * Phase E-15.3b — V2DashboardStorage tests.
 *
 * The welcome-dismissed key has a 30-day TTL and a legacy "1" sentinel
 * migration path. Both behaviors are easy to get wrong on refactor. Lock
 * them down with a happy-path matrix.
 *
 * We stub `window.localStorage` so the test runs in vitest's node env
 * (no jsdom needed).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  STORAGE_WELCOME_DISMISSED,
  WELCOME_TTL_MS,
  readWelcomeDismissed,
  writeWelcomeDismissed,
} from "./V2DashboardStorage";

class MemStorage {
  store = new Map<string, string>();
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  clear() {
    this.store.clear();
  }
}

let store: MemStorage;

beforeEach(() => {
  store = new MemStorage();
  // @ts-expect-error — stubbing global for the test
  globalThis.window = { localStorage: store };
});

afterEach(() => {
  // @ts-expect-error — clean up the stub
  delete globalThis.window;
});

describe("readWelcomeDismissed — fresh state", () => {
  it("returns false when nothing is stored", () => {
    expect(readWelcomeDismissed()).toBe(false);
  });

  it("returns false when storage throws (private mode simulation)", () => {
    store.getItem = () => {
      throw new Error("private mode");
    };
    expect(readWelcomeDismissed()).toBe(false);
  });
});

describe("readWelcomeDismissed — legacy '1' value migration", () => {
  it("treats the legacy '1' string as freshly dismissed", () => {
    store.setItem(STORAGE_WELCOME_DISMISSED, "1");
    expect(readWelcomeDismissed()).toBe(true);
  });

  it("rewrites '1' to the {at:timestamp} shape so the TTL takes effect", () => {
    store.setItem(STORAGE_WELCOME_DISMISSED, "1");
    readWelcomeDismissed();
    const after = store.getItem(STORAGE_WELCOME_DISMISSED);
    expect(after).not.toBe("1");
    const parsed = JSON.parse(after!) as { at: number };
    expect(typeof parsed.at).toBe("number");
    expect(parsed.at).toBeGreaterThan(Date.now() - 5_000);
  });
});

describe("readWelcomeDismissed — TTL behavior", () => {
  it("returns true for a fresh dismissal (within TTL)", () => {
    const recent = Date.now() - 1000; // 1s ago
    store.setItem(STORAGE_WELCOME_DISMISSED, JSON.stringify({ at: recent }));
    expect(readWelcomeDismissed()).toBe(true);
  });

  it("returns true at the TTL boundary (just under)", () => {
    const justUnder = Date.now() - (WELCOME_TTL_MS - 1000);
    store.setItem(STORAGE_WELCOME_DISMISSED, JSON.stringify({ at: justUnder }));
    expect(readWelcomeDismissed()).toBe(true);
  });

  it("returns false when older than the 30-day TTL", () => {
    const expired = Date.now() - (WELCOME_TTL_MS + 86_400_000);
    store.setItem(STORAGE_WELCOME_DISMISSED, JSON.stringify({ at: expired }));
    expect(readWelcomeDismissed()).toBe(false);
  });

  it("removes the expired entry so subsequent reads stay false", () => {
    const expired = Date.now() - (WELCOME_TTL_MS + 86_400_000);
    store.setItem(STORAGE_WELCOME_DISMISSED, JSON.stringify({ at: expired }));
    readWelcomeDismissed();
    expect(store.getItem(STORAGE_WELCOME_DISMISSED)).toBeNull();
  });
});

describe("readWelcomeDismissed — defensive parsing", () => {
  it("returns false for malformed JSON", () => {
    store.setItem(STORAGE_WELCOME_DISMISSED, "not-json{");
    expect(readWelcomeDismissed()).toBe(false);
  });

  it("returns false for valid JSON missing the 'at' field", () => {
    store.setItem(STORAGE_WELCOME_DISMISSED, JSON.stringify({ foo: "bar" }));
    expect(readWelcomeDismissed()).toBe(false);
  });

  it("returns false for valid JSON where 'at' is non-numeric", () => {
    store.setItem(STORAGE_WELCOME_DISMISSED, JSON.stringify({ at: "yesterday" }));
    expect(readWelcomeDismissed()).toBe(false);
  });
});

describe("writeWelcomeDismissed", () => {
  it("writes the {at:now} shape", () => {
    writeWelcomeDismissed();
    const raw = store.getItem(STORAGE_WELCOME_DISMISSED);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { at: number };
    expect(parsed.at).toBeGreaterThan(Date.now() - 5_000);
    expect(parsed.at).toBeLessThanOrEqual(Date.now());
  });

  it("silently swallows storage errors (quota / private mode)", () => {
    store.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => writeWelcomeDismissed()).not.toThrow();
  });
});

describe("readWelcomeDismissed — SSR safety", () => {
  it("returns false when window is undefined (SSR / build-time)", () => {
    // @ts-expect-error — simulate SSR by removing the stub
    delete globalThis.window;
    expect(readWelcomeDismissed()).toBe(false);
  });
});
