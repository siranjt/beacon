/**
 * Wave-1 (hybrid retrieval) — pure-function tests.
 *
 * Covers mergeRRF math + retrieveFactsHybrid edge cases. End-to-end
 * tests (with real Voyage + Postgres) belong in the manual smoke run,
 * not in CI — these tests stay fast and dependency-free.
 */

import { describe, it, expect } from "vitest";
import { mergeRRF, retrieveFactsHybrid, RRF_K } from "./retrieve";
import type { BrainFact } from "./types";

/* Test fixtures — minimal BrainFact rows. We only populate the fields
 * mergeRRF reads (fact_id) plus enough metadata for the type check. */
function f(id: string): BrainFact {
  return {
    fact_id: id,
    customer_id: "c1",
    topic_category: "identity",
    topic_subcategory: "owner",
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
  } as BrainFact;
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
