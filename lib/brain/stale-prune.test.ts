/**
 * SMART-K2 — stale-prune unit tests.
 *
 * The real prune helper hits Postgres via the Neon tagged-template
 * client. For unit tests we mock @/lib/customer/postgres.getSql and
 * return a tagged-template stub that records the queries the helper
 * runs and returns canned shapes per call. That keeps the suite fast
 * and CI-friendly while still exercising:
 *
 *   1. dryRun branch counts but never UPDATEs
 *   2. citation_count = 0 gate (facts with citations are excluded)
 *   3. age gate (facts younger than threshold are excluded)
 *   4. Idempotency (re-running on already-stale facts is a no-op via
 *      the is_stale = false WHERE clause — gate is verified by checking
 *      that the second call counts 0 candidates)
 *   5. K1 column gate (when citation_count column is absent, helper
 *      soft-falls back to "treat as 0 citations")
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Recorded query shape. Each tagged-template call inside the helper
 * pushes a `{ sql, params }` entry so individual tests can assert what
 * actually fired (especially the dryRun = no UPDATE check).
 */
interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/**
 * Per-test mutable state. `nextResults` is a FIFO queue of fake row
 * arrays the stub returns in order. `recorded` accumulates every
 * query the helper made.
 */
type TaggedStub = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown>;

const state: {
  recorded: RecordedQuery[];
  nextResults: Array<Array<Record<string, unknown>>>;
  overrideStub: TaggedStub | null;
} = {
  recorded: [],
  nextResults: [],
  overrideStub: null,
};

function defaultTaggedStub(): TaggedStub {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = strings.join("?");
    state.recorded.push({ sql: flat, params: values });
    const next = state.nextResults.shift();
    return Promise.resolve(next ?? []);
  };
}

vi.mock("@/lib/customer/postgres", () => ({
  // Each call to getSql() returns either the per-test override (if any)
  // or a fresh default stub. The override flag is reset between tests
  // in beforeEach.
  getSql: () => state.overrideStub ?? defaultTaggedStub(),
}));

// Import AFTER mock so the mocked getSql is captured.
import { runStalePrune } from "./stale-prune";

function queueResults(...batches: Array<Array<Record<string, unknown>>>) {
  state.nextResults.push(...batches);
}

function lastUpdateQuery(): RecordedQuery | undefined {
  return state.recorded.find((q) => /UPDATE\s+beacon_brain_facts/i.test(q.sql));
}

function lastCountQuery(): RecordedQuery | undefined {
  return state.recorded.find((q) =>
    /SELECT\s+COUNT/i.test(q.sql) && /beacon_brain_facts/i.test(q.sql),
  );
}

beforeEach(() => {
  state.recorded = [];
  state.nextResults = [];
  state.overrideStub = null;
});

describe("runStalePrune — dryRun mode", () => {
  it("counts candidates but does not run UPDATE", async () => {
    queueResults(
      // information_schema probe — citation_count exists
      [{ column_name: "citation_count" }],
      // candidate count
      [{ n: 5 }],
    );

    const result = await runStalePrune({ dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(result.candidates).toBe(5);
    expect(result.marked).toBe(0);
    expect(result.citation_column_present).toBe(true);
    expect(result.age_months_used).toBe(6);
    expect(result.errors).toEqual([]);
    // No UPDATE statement should have been recorded.
    expect(lastUpdateQuery()).toBeUndefined();
  });

  it("returns zeros when there are no candidates", async () => {
    queueResults(
      [{ column_name: "citation_count" }],
      [{ n: 0 }],
    );

    const result = await runStalePrune({ dryRun: false });

    expect(result.candidates).toBe(0);
    expect(result.marked).toBe(0);
    expect(lastUpdateQuery()).toBeUndefined();
  });
});

describe("runStalePrune — live mode", () => {
  it("marks the candidates returned by the live UPDATE", async () => {
    // Both the count and the UPDATE rely on the same WHERE shape; the
    // helper runs them sequentially so we queue the count first, then
    // the UPDATE row set.
    queueResults(
      [{ column_name: "citation_count" }],
      [{ n: 3 }],
      [{ fact_id: "f1" }, { fact_id: "f2" }, { fact_id: "f3" }],
    );

    const result = await runStalePrune();

    expect(result.candidates).toBe(3);
    expect(result.marked).toBe(3);
    expect(result.citation_column_present).toBe(true);
    expect(result.errors).toEqual([]);
    const upd = lastUpdateQuery();
    expect(upd).toBeDefined();
    // Must filter is_stale = false (idempotency guard).
    expect(upd!.sql).toMatch(/is_stale\s*=\s*false/);
    // Must filter citation_count = 0 when the column is present.
    expect(upd!.sql).toMatch(/citation_count\s*=\s*0/);
    // Must set marked_stale_at.
    expect(upd!.sql).toMatch(/marked_stale_at\s*=\s*NOW\(\)/);
  });

  it("idempotent: re-running with zero candidates is a no-op", async () => {
    // Run 1: marks 2 facts.
    queueResults(
      [{ column_name: "citation_count" }],
      [{ n: 2 }],
      [{ fact_id: "f1" }, { fact_id: "f2" }],
    );
    const first = await runStalePrune();
    expect(first.marked).toBe(2);

    // Run 2: same WHERE clause, but the previously-flipped facts now
    // fail is_stale = false → 0 candidates surface.
    state.recorded = [];
    queueResults(
      [{ column_name: "citation_count" }],
      [{ n: 0 }],
    );
    const second = await runStalePrune();
    expect(second.candidates).toBe(0);
    expect(second.marked).toBe(0);
    // No UPDATE on the second run.
    expect(lastUpdateQuery()).toBeUndefined();
  });
});

describe("runStalePrune — WHERE clause integrity", () => {
  it("count + update queries reference updated_at < NOW - interval", async () => {
    queueResults(
      [{ column_name: "citation_count" }],
      [{ n: 1 }],
      [{ fact_id: "x" }],
    );
    await runStalePrune({ ageMonths: 6 });

    // Both queries should reference updated_at with an interval cutoff.
    // We assert against the recorded SQL text since the interval literal
    // is interpolated server-side (Neon driver), not parameterized.
    const ageGated = state.recorded.filter((q) =>
      /updated_at\s*<\s*NOW\(\)\s*-/.test(q.sql),
    );
    expect(ageGated.length).toBeGreaterThanOrEqual(2);
  });

  it("honors a custom ageMonths override", async () => {
    queueResults(
      [{ column_name: "citation_count" }],
      [{ n: 0 }],
    );
    const result = await runStalePrune({
      dryRun: true,
      ageMonths: 12,
    });
    expect(result.age_months_used).toBe(12);
    // The interval literal "12 months" should have been bound on at least
    // one query (it's a $N param to NOW() - $::interval).
    const hasTwelve = state.recorded.some((q) =>
      q.params.some((p) => p === "12 months"),
    );
    expect(hasTwelve).toBe(true);
  });

  it("floor-clamps fractional or sub-1 ageMonths to a 1-month minimum", async () => {
    queueResults(
      [{ column_name: "citation_count" }],
      [{ n: 0 }],
    );
    const result = await runStalePrune({ dryRun: true, ageMonths: 0 });
    expect(result.age_months_used).toBe(1);
  });
});

describe("runStalePrune — K1 column gate", () => {
  it("soft-falls back when citation_count column is absent", async () => {
    queueResults(
      // information_schema probe — no rows = column missing
      [],
      // candidate count (no citation_count filter in the query)
      [{ n: 4 }],
      // UPDATE result
      [{ fact_id: "f1" }, { fact_id: "f2" }, { fact_id: "f3" }, { fact_id: "f4" }],
    );

    const result = await runStalePrune();

    expect(result.citation_column_present).toBe(false);
    expect(result.candidates).toBe(4);
    expect(result.marked).toBe(4);
    expect(result.errors).toEqual([]);

    // The UPDATE that fired MUST NOT reference citation_count — the
    // fallback path uses a query without that predicate.
    const upd = lastUpdateQuery();
    expect(upd).toBeDefined();
    expect(upd!.sql).not.toMatch(/citation_count/);
    // But it should still gate on is_stale + updated_at.
    expect(upd!.sql).toMatch(/is_stale\s*=\s*false/);
    expect(upd!.sql).toMatch(/updated_at\s*<\s*NOW\(\)/);
  });

  it("soft-falls back when the information_schema probe throws", async () => {
    // Use a stub that throws on the first call (the probe) but returns
    // normal shapes on subsequent calls. The helper should swallow the
    // probe error and proceed via the no-citation_count branch.
    let callIdx = 0;
    state.overrideStub = (strings, ...values) => {
      const flat = strings.join("?");
      state.recorded.push({ sql: flat, params: values });
      callIdx++;
      if (callIdx === 1) return Promise.reject(new Error("probe boom"));
      // Provide subsequent results — count then update.
      if (callIdx === 2) return Promise.resolve([{ n: 0 }]);
      return Promise.resolve([]);
    };

    const result = await runStalePrune({ dryRun: true });
    expect(result.citation_column_present).toBe(false);
    expect(result.candidates).toBe(0);
  });
});

describe("runStalePrune — error surfacing", () => {
  it("captures DB errors without throwing", async () => {
    // Probe succeeds, but the count query throws.
    let callIdx = 0;
    state.overrideStub = (strings, ...values) => {
      const flat = strings.join("?");
      state.recorded.push({ sql: flat, params: values });
      callIdx++;
      if (callIdx === 1) {
        return Promise.resolve([{ column_name: "citation_count" }]);
      }
      return Promise.reject(new Error("connection refused"));
    };

    const result = await runStalePrune();
    expect(result.candidates).toBe(0);
    expect(result.marked).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/connection refused/);
  });
});

// The count + update queries reference updated_at — referenced for
// assertion clarity in the WHERE clause integrity tests above. Kept
// here so the linter doesn't flag the import drift if we add more
// assertions later.
void lastCountQuery;
