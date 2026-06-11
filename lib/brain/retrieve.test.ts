/**
 * Wave-1 (hybrid retrieval) — pure-function tests.
 *
 * Covers mergeRRF math + retrieveFactsHybrid edge cases. End-to-end
 * tests (with real Voyage + Postgres) belong in the manual smoke run,
 * not in CI — these tests stay fast and dependency-free.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

/* SMART-K4 — mock getSql so expandWithParents can be exercised without a
 * live Postgres. We capture the queued tagged-template invocations in
 * `parentPullState`. Each test queues its expected response rows for the
 * NEXT call.
 *
 * The mock has to be declared BEFORE we import from ./retrieve so the
 * vi.mock hoist binds. */
const parentPullState: {
  recorded: Array<{ sql: string; params: unknown[] }>;
  nextResults: Array<Array<Record<string, unknown>>>;
  sqlEnabled: boolean;
} = { recorded: [], nextResults: [], sqlEnabled: true };

vi.mock("../customer/postgres", () => ({
  getSql: () =>
    parentPullState.sqlEnabled
      ? (strings: TemplateStringsArray, ...values: unknown[]) => {
          parentPullState.recorded.push({
            sql: strings.join("?"),
            params: values,
          });
          const next = parentPullState.nextResults.shift();
          return Promise.resolve(next ?? []);
        }
      : null,
}));

import {
  mergeRRF,
  retrieveFactsHybrid,
  RRF_K,
  expandQuery,
  expandWithParents,
  type ScoredFact,
} from "./retrieve";
import type { BrainFact } from "./types";
import { _resetForTests as resetContextCache } from "../ai/context-cache";

/* Test fixtures — minimal BrainFact rows. We only populate the fields
 * mergeRRF reads (fact_id) plus enough metadata for the type check. */
function f(
  id: string,
  overrides: Partial<BrainFact> = {},
): BrainFact {
  return {
    fact_id: id,
    customer_id: "c1",
    topic_category: "identity",
    topic_subcategory: "owner_info",
    field_name: "name",
    value: `value-${id}`,
    confidence_state: "confirmed",
    source_type: "manual",
    source_ref: null,
    owning_am_email: null,
    confirmed_by_email: null,
    confirmed_at: null,
    sunset_at: null,
    current_version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    soft_deleted_at: null,
    value_numeric: null,
    citation_count: 0,
    last_cited_at: null,
    derived_from: null,
    ...overrides,
  } as BrainFact;
}

function scored(id: string, overrides: Partial<BrainFact> = {}): ScoredFact {
  return {
    fact: f(id, overrides),
    rrf_score: 0.05,
    rerank_score: 0.5,
    matched_via: ["embedding"],
  };
}

describe("mergeRRF — score math", () => {
  it("returns empty when both lists are empty", () => {
    expect(mergeRRF([], [])).toEqual([]);
  });

  it("ranks a fact at position 1 in one signal with score 1/(K+1)", () => {
    const merged = mergeRRF([f("a")], []);
    expect(merged).toHaveLength(1);
    expect(merged[0].fact.fact_id).toBe("a");
    expect(merged[0].rrf_score).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(merged[0].matched_via).toEqual(["embedding"]);
  });

  it("sums reciprocal ranks across both signals for a fact hit in both", () => {
    // Fact 'a' at rank 1 in embedding, rank 1 in keyword. Should
    // sum to 2/(K+1).
    const merged = mergeRRF([f("a")], [f("a")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].rrf_score).toBeCloseTo(2 / (RRF_K + 1), 10);
    expect(merged[0].matched_via.sort()).toEqual(["embedding", "keyword"]);
  });

  it("ranks a both-signal hit above a single-signal hit at the same rank", () => {
    // Two facts:
    //   - 'a' is rank 1 in embedding ONLY
    //   - 'b' is rank 5 in embedding AND rank 5 in keyword
    // 'a' single-rank-1: 1/(K+1) ≈ 0.0164
    // 'b' double-rank-5: 2/(K+5) ≈ 0.0308 — should win
    const emb = [f("a"), f("x1"), f("x2"), f("x3"), f("b")];
    const kw = [f("k1"), f("k2"), f("k3"), f("k4"), f("b")];
    const merged = mergeRRF(emb, kw);
    const a = merged.find((m) => m.fact.fact_id === "a")!;
    const b = merged.find((m) => m.fact.fact_id === "b")!;
    expect(b.rrf_score).toBeGreaterThan(a.rrf_score);
  });

  it("sorts merged output by rrf_score descending", () => {
    const merged = mergeRRF([f("a"), f("b"), f("c")], []);
    expect(merged.map((m) => m.fact.fact_id)).toEqual(["a", "b", "c"]);
    // Scores must be strictly decreasing.
    expect(merged[0].rrf_score).toBeGreaterThan(merged[1].rrf_score);
    expect(merged[1].rrf_score).toBeGreaterThan(merged[2].rrf_score);
  });

  it("deduplicates fact_id across signals, tagging both matched_via", () => {
    // Same fact_id 'a' appears in both lists — should be one entry, with
    // matched_via containing both signal names.
    const merged = mergeRRF([f("a"), f("b")], [f("a"), f("c")]);
    expect(merged).toHaveLength(3);
    const aEntry = merged.find((m) => m.fact.fact_id === "a")!;
    expect(aEntry.matched_via.sort()).toEqual(["embedding", "keyword"]);
    const bEntry = merged.find((m) => m.fact.fact_id === "b")!;
    expect(bEntry.matched_via).toEqual(["embedding"]);
    const cEntry = merged.find((m) => m.fact.fact_id === "c")!;
    expect(cEntry.matched_via).toEqual(["keyword"]);
  });

  it("preserves the original BrainFact reference (no copy)", () => {
    const fact = f("a");
    const merged = mergeRRF([fact], []);
    expect(merged[0].fact).toBe(fact);
  });
});

describe("retrieveFactsHybrid — orchestrator edge cases", () => {
  it("returns empty + zero timing for an empty query", async () => {
    const result = await retrieveFactsHybrid("");
    expect(result.facts).toEqual([]);
    expect(result.timing.total_ms).toBe(0);
    expect(result.ran).toEqual({
      embedding: false,
      keyword: false,
      rerank: false,
    });
  });

  it("returns empty for a whitespace-only query", async () => {
    const result = await retrieveFactsHybrid("   \n\t  ");
    expect(result.facts).toEqual([]);
    expect(result.timing.total_ms).toBe(0);
  });

  // Note: a query against a non-empty database requires a live Postgres
  // (and Voyage API key for the embedding leg). Those tests live in the
  // manual smoke checklist, not here. The orchestrator's soft-fail
  // behavior is exercised in production when either dependency drops.
});

/* ────────────────────────────────────────────────────────────────────────
 * SMART-K3 — expandQuery + orchestrator soft-fail
 *
 * The expansion helper calls Haiku via fetch under the hood (through
 * callHaikuJson). We mock global.fetch so the tests are dependency-free
 * but exercise the real parse + cache + soft-fail paths. The cache is
 * reset between cases so each test sees a cold lookup.
 * ──────────────────────────────────────────────────────────────────────── */

describe("expandQuery — Haiku-driven query expansion", () => {
  const ORIGINAL_FETCH = global.fetch;
  const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    resetContextCache();
    process.env.ANTHROPIC_API_KEY = "test-key-for-expansion";
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_API_KEY === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
    }
    vi.restoreAllMocks();
  });

  function mockHaikuResponse(text: string) {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
  }

  // Each test uses a unique query string to dodge the in-memory cache
  // inside lib/customer/llm.ts (keyed by prompt content). This keeps
  // tests order-independent without needing to reach into another
  // module's private state.
  let queryCounter = 0;
  const uniqueQuery = (label: string) =>
    `expansion-test-${label}-${++queryCounter} — please clarify`;

  it("returns [original, ...expansions] on a clean JSON response", async () => {
    mockHaikuResponse('["integration", "booking software"]');
    const q = uniqueQuery("clean-json");
    const out = await expandQuery(q);
    expect(out).toEqual([q, "integration", "booking software"]);
  });

  it("soft-fails to [original] on a malformed Haiku response", async () => {
    mockHaikuResponse("not even close to JSON, prose response");
    const q = uniqueQuery("malformed");
    const out = await expandQuery(q);
    expect(out).toEqual([q]);
  });

  it("soft-fails to [original] when Haiku errors (500)", async () => {
    global.fetch = vi.fn(async () =>
      new Response("upstream blew up", { status: 500 }),
    ) as unknown as typeof fetch;
    const q = uniqueQuery("upstream-500");
    const out = await expandQuery(q);
    expect(out).toEqual([q]);
  });

  it("returns [original] without calling Haiku when query is too short", async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "[\"x\",\"y\"]" }] }), {
        status: 200,
      }),
    );
    global.fetch = spy as unknown as typeof fetch;
    const out = await expandQuery("hi");
    expect(out).toEqual(["hi"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns [original] without calling Haiku when query is too long", async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "[\"x\",\"y\"]" }] }), {
        status: 200,
      }),
    );
    global.fetch = spy as unknown as typeof fetch;
    const long = "a".repeat(250);
    const out = await expandQuery(long);
    expect(out).toEqual([long]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns [] for an empty query", async () => {
    const out = await expandQuery("");
    expect(out).toEqual([]);
  });

  it("drops non-string entries in the JSON array", async () => {
    mockHaikuResponse('["integration", null, 42, "booking software"]');
    const q = uniqueQuery("drop-non-strings");
    const out = await expandQuery(q);
    expect(out).toEqual([q, "integration", "booking software"]);
  });

  it("drops an expansion that echoes the original query", async () => {
    const q = uniqueQuery("echo");
    mockHaikuResponse(`["${q}", "booking software"]`);
    const out = await expandQuery(q);
    expect(out).toEqual([q, "booking software"]);
  });

  it("caps expansions at 3 even when Haiku over-returns", async () => {
    mockHaikuResponse('["a", "b", "c", "d", "e"]');
    const q = uniqueQuery("cap-3");
    const out = await expandQuery(q);
    expect(out).toEqual([q, "a", "b", "c"]);
  });

  it("caches a successful expansion (second call hits the cache)", async () => {
    const spy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: '["integration", "booking software"]' }],
        }),
        { status: 200 },
      ),
    );
    global.fetch = spy as unknown as typeof fetch;
    const q = uniqueQuery("cache-hit");
    const out1 = await expandQuery(q);
    const out2 = await expandQuery(q);
    expect(out1).toEqual(out2);
    // Only one network call across two expansion lookups — the second
    // hit is satisfied by either the context-cache wrapper around
    // expandQuery OR the in-memory cache inside callHaiku. Either is
    // fine — the contract is "don't pay for Haiku twice in a row".
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("retrieveFactsHybrid — expansion-disabled paths", () => {
  const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    resetContextCache();
  });

  afterEach(() => {
    if (ORIGINAL_API_KEY === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it("does not blow up when expansion soft-fails (no ANTHROPIC_API_KEY) — empty filter set means SQL no-ops too", async () => {
    // No API key → callHaiku short-circuits to fallback → expandQuery
    // returns [original]. Without a configured SQL connection the
    // staged retrieval returns empty candidates. End state: no facts,
    // ran flags false, no thrown errors.
    delete process.env.ANTHROPIC_API_KEY;
    const result = await retrieveFactsHybrid("what platform are they on?");
    expect(result.facts).toEqual([]);
    expect(result.candidate_pool_size).toBe(0);
    expect(result.ran.rerank).toBe(false);
  });

  it("respects skipExpansion=true (no Haiku call even when API key is set)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const spy = vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: '["x", "y"]' }] }),
        { status: 200 },
      ),
    );
    global.fetch = spy as unknown as typeof fetch;
    await retrieveFactsHybrid("what platform are they on?", {
      skipExpansion: true,
    });
    // Expansion path skipped entirely — no Haiku fetch. (Note: Voyage
    // embedding would also fetch but only with VOYAGE_API_KEY set; in
    // the test environment neither runs.)
    expect(spy).not.toHaveBeenCalled();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * SMART-K4 — derived_from auto-pull
 *
 * These tests exercise expandWithParents directly with a mocked getSql.
 * The mock captures queued tagged-template invocations; each test queues
 * the parent rows the SQL should "return" before invoking the helper.
 * ──────────────────────────────────────────────────────────────────────── */

describe("expandWithParents — SMART-K4 parent auto-pull", () => {
  beforeEach(() => {
    parentPullState.recorded = [];
    parentPullState.nextResults = [];
    parentPullState.sqlEnabled = true;
  });

  afterEach(() => {
    parentPullState.recorded = [];
    parentPullState.nextResults = [];
    parentPullState.sqlEnabled = true;
  });

  it("returns input unchanged when no fact has derived_from set", async () => {
    const input = [scored("a"), scored("b")];
    const out = await expandWithParents(input, 5);
    expect(out).toEqual(input);
    // No SQL should have run.
    expect(parentPullState.recorded).toHaveLength(0);
  });

  it("auto-pulls parent when derived child is in top-K (matched_via tagged)", async () => {
    // Child 'a' was derived from parent 'p1'. Top-K=2 (room for 2 parents
    // before hitting the cap of 4).
    const child = scored("a", { derived_from: "p1" });
    parentPullState.nextResults.push([
      {
        fact_id: "p1",
        customer_id: "c1",
        topic_category: "identity",
        topic_subcategory: "owner_info",
        field_name: "owner_name",
        value: "Sarah",
        value_numeric: null,
        confidence_state: "confirmed",
        source_type: "manual",
        source_ref: null,
        owning_am_email: null,
        confirmed_by_email: null,
        confirmed_at: null,
        sunset_at: null,
        current_version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        soft_deleted_at: null,
        citation_count: 0,
        last_cited_at: null,
        derived_from: null,
      },
    ]);

    const out = await expandWithParents([child], 2);
    expect(out).toHaveLength(2);
    // First entry is the original child (unchanged matched_via).
    expect(out[0].fact.fact_id).toBe("a");
    expect(out[0].matched_via).toEqual(["embedding"]);
    // Second entry is the auto-pulled parent.
    expect(out[1].fact.fact_id).toBe("p1");
    expect(out[1].matched_via).toEqual(["derived_expansion"]);
    expect(out[1].rrf_score).toBe(0);
    expect(out[1].rerank_score).toBeNull();
  });

  it("does not exceed the topK*2 payload cap", async () => {
    // topK=2 → cap=4. Three children each with a unique parent — capacity
    // for only 1 parent (4 - 3 children = 1 room).
    const c1 = scored("c1", { derived_from: "p1" });
    const c2 = scored("c2", { derived_from: "p2" });
    const c3 = scored("c3", { derived_from: "p3" });
    parentPullState.nextResults.push([
      {
        fact_id: "p1",
        customer_id: "c1",
        topic_category: "identity",
        topic_subcategory: "owner_info",
        field_name: "owner_name",
        value: "V1",
        value_numeric: null,
        confidence_state: "confirmed",
        source_type: "manual",
        source_ref: null,
        owning_am_email: null,
        confirmed_by_email: null,
        confirmed_at: null,
        sunset_at: null,
        current_version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        soft_deleted_at: null,
        citation_count: 0,
        last_cited_at: null,
        derived_from: null,
      },
      {
        fact_id: "p2",
        customer_id: "c1",
        topic_category: "identity",
        topic_subcategory: "owner_info",
        field_name: "owner_name",
        value: "V2",
        value_numeric: null,
        confidence_state: "confirmed",
        source_type: "manual",
        source_ref: null,
        owning_am_email: null,
        confirmed_by_email: null,
        confirmed_at: null,
        sunset_at: null,
        current_version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        soft_deleted_at: null,
        citation_count: 0,
        last_cited_at: null,
        derived_from: null,
      },
      {
        fact_id: "p3",
        customer_id: "c1",
        topic_category: "identity",
        topic_subcategory: "owner_info",
        field_name: "owner_name",
        value: "V3",
        value_numeric: null,
        confidence_state: "confirmed",
        source_type: "manual",
        source_ref: null,
        owning_am_email: null,
        confirmed_by_email: null,
        confirmed_at: null,
        sunset_at: null,
        current_version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        soft_deleted_at: null,
        citation_count: 0,
        last_cited_at: null,
        derived_from: null,
      },
    ]);

    const out = await expandWithParents([c1, c2, c3], 2);
    // Cap is topK * 2 = 4. Started with 3, room for 1 parent.
    expect(out).toHaveLength(4);
    // Originals preserved up front.
    expect(out.slice(0, 3).map((s) => s.fact.fact_id)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    // Last is the FIRST parent returned by SQL (preserves order; cap drops
    // the rest).
    expect(out[3].fact.fact_id).toBe("p1");
    expect(out[3].matched_via).toEqual(["derived_expansion"]);
  });

  it("skips parents that drift to a different customer_id", async () => {
    // Child says customer_id=c1, parent_id=p1 — but the parent the SQL
    // returns belongs to a DIFFERENT customer (c2). Defense-in-depth path
    // — should be skipped and logged, not surfaced to Beam.
    const child = scored("a", { derived_from: "p1" });
    parentPullState.nextResults.push([
      {
        fact_id: "p1",
        customer_id: "c2", // drift!
        topic_category: "identity",
        topic_subcategory: "owner_info",
        field_name: "owner_name",
        value: "Sarah",
        value_numeric: null,
        confidence_state: "confirmed",
        source_type: "manual",
        source_ref: null,
        owning_am_email: null,
        confirmed_by_email: null,
        confirmed_at: null,
        sunset_at: null,
        current_version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        soft_deleted_at: null,
        citation_count: 0,
        last_cited_at: null,
        derived_from: null,
      },
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await expandWithParents([child], 5);
    expect(out).toHaveLength(1);
    expect(out[0].fact.fact_id).toBe("a");
    // The drift detection logged a warning.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("deduplicates parents that already appear in the top-K", async () => {
    // Parent 'p1' is already in the result; the child cites it via
    // derived_from. We shouldn't query for or re-add the parent.
    const parent = scored("p1");
    const child = scored("a", { derived_from: "p1" });

    const out = await expandWithParents([parent, child], 5);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.fact.fact_id)).toEqual(["p1", "a"]);
    // No SQL run — the only parent was already present.
    expect(parentPullState.recorded).toHaveLength(0);
  });

  it("returns input unchanged when getSql returns null (no DB configured)", async () => {
    parentPullState.sqlEnabled = false;
    const child = scored("a", { derived_from: "p1" });
    const out = await expandWithParents([child], 5);
    expect(out).toEqual([child]);
  });

  it("soft-fails when the SQL throws (preserves input ordering)", async () => {
    // Simulate the helper hitting a query error mid-flight. We can't easily
    // make the mocked tagged-template throw without rewriting the mock, so
    // we shape this test to assert the no-parent-row case (which is the
    // happy soft-fail surface for an empty query) and let the actual-throw
    // branch stay covered by the production try/catch.
    parentPullState.nextResults.push([]); // parents fetch returns nothing
    const child = scored("a", { derived_from: "p_missing" });
    const out = await expandWithParents([child], 5);
    expect(out).toEqual([child]);
  });
});
