/**
 * Wave-2 (ranking) — pure-function tests.
 *
 * Covers recency decay, confidence multiplier, source-trust ordering,
 * composite score, and cluster resolution. The DB-touching helpers
 * (findClusterMembers, persistResolution, applyConflictResolution)
 * are exercised in the manual smoke run, not in CI — they need a
 * live Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recencyWeight,
  confidenceMultiplier,
  sourceTrust,
  amFeedbackBoost,
  computeRankingScore,
  resolveCluster,
  persistResolution,
  RECENCY_HALF_LIFE_DAYS,
} from "./ranking";
import type { BrainFact } from "./types";

// Mock the postgres client so persistResolution can be unit-tested without a
// real DB. We capture the SQL strings + parameters via a tagged-template
// recorder and assert against them.
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const sqlCalls: SqlCall[] = [];

vi.mock("../customer/postgres", () => ({
  getSql: () => {
    // Tagged-template function: (strings, ...values) => Promise<rows>
    const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ strings, values });
      return Promise.resolve([] as unknown[]);
    };
    return fn;
  },
}));

beforeEach(() => {
  sqlCalls.length = 0;
});

/* Test fixture — minimal BrainFact rows. */
function f(opts: {
  fact_id?: string;
  updated_at?: Date | string | null;
  confidence_state?: "confirmed" | "candidate";
  source_type?: string;
  citation_count?: number;
  last_cited_at?: string | null;
}): BrainFact {
  return {
    fact_id: opts.fact_id ?? "test-id",
    customer_id: "c1",
    topic_category: "identity",
    topic_subcategory: "owner_info",
    field_name: "name",
    value: "value",
    confidence_state: opts.confidence_state ?? "confirmed",
    source_type: opts.source_type ?? "manual",
    source_ref: null,
    owning_am_email: null,
    confirmed_by_email: null,
    confirmed_at: null,
    sunset_at: null,
    current_version: 1,
    created_at: new Date().toISOString(),
    updated_at:
      opts.updated_at === undefined
        ? new Date().toISOString()
        : opts.updated_at instanceof Date
          ? opts.updated_at.toISOString()
          : opts.updated_at,
    soft_deleted_at: null,
    value_numeric: null,
    citation_count: opts.citation_count ?? 0,
    last_cited_at: opts.last_cited_at ?? null,
  } as BrainFact;
}

describe("recencyWeight — exponential decay", () => {
  it("returns 1.0 for a just-now timestamp", () => {
    expect(recencyWeight(new Date())).toBeCloseTo(1, 2);
  });

  it("returns 1.0 for a future-dated timestamp (clamped to now)", () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    expect(recencyWeight(future)).toBe(1);
  });

  it("returns 0.5 at the half-life (60 days)", () => {
    const halfLifeAgo = new Date(
      Date.now() - RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(recencyWeight(halfLifeAgo)).toBeCloseTo(0.5, 2);
  });

  it("returns 0.125 at 3x the half-life (180 days)", () => {
    const ago = new Date(
      Date.now() - 3 * RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(recencyWeight(ago)).toBeCloseTo(0.125, 2);
  });

  it("returns 0 for null input", () => {
    expect(recencyWeight(null)).toBe(0);
  });

  it("returns 0 for an unparseable timestamp", () => {
    expect(recencyWeight("not a date")).toBe(0);
  });

  it("accepts ISO string input", () => {
    expect(recencyWeight(new Date().toISOString())).toBeCloseTo(1, 2);
  });
});

describe("confidenceMultiplier", () => {
  it("returns 1.0 for confirmed", () => {
    expect(confidenceMultiplier("confirmed")).toBe(1);
  });

  it("returns 0.3 for candidate", () => {
    expect(confidenceMultiplier("candidate")).toBe(0.3);
  });
});

describe("sourceTrust — ordering", () => {
  it("ranks system-of-record sources at the top (1.0)", () => {
    expect(sourceTrust("basesheet")).toBe(1.0);
    expect(sourceTrust("chargebee")).toBe(1.0);
  });

  it("ranks manual AM writes above note extractions", () => {
    expect(sourceTrust("manual")).toBeGreaterThan(sourceTrust("customer_note"));
  });

  it("ranks customer_note above beacon_ai_extracted", () => {
    expect(sourceTrust("customer_note")).toBeGreaterThan(
      sourceTrust("beacon_ai_extracted"),
    );
  });

  it("ranks beacon_ai_extracted above beacon_ai_conversation", () => {
    expect(sourceTrust("beacon_ai_extracted")).toBeGreaterThan(
      sourceTrust("beacon_ai_conversation"),
    );
  });

  it("falls to 0.5 for unknown source_type", () => {
    expect(sourceTrust("unknown_source")).toBe(0.5);
    expect(sourceTrust("")).toBe(0.5);
  });

  it("orders the full hierarchy as expected", () => {
    expect(sourceTrust("basesheet")).toBeGreaterThanOrEqual(sourceTrust("manual"));
    expect(sourceTrust("manual")).toBeGreaterThan(sourceTrust("customer_note"));
    expect(sourceTrust("customer_note")).toBeGreaterThan(
      sourceTrust("beacon_ai_extracted"),
    );
    expect(sourceTrust("beacon_ai_extracted")).toBeGreaterThan(
      sourceTrust("beacon_ai_conversation"),
    );
    expect(sourceTrust("beacon_ai_conversation")).toBeGreaterThan(
      sourceTrust("unknown_source"),
    );
  });
});

describe("amFeedbackBoost — SMART-K1 citation-driven boost", () => {
  it("returns 1.0 (no boost) for zero citations", () => {
    expect(amFeedbackBoost(0)).toBe(1);
  });

  it("returns 1.0 for negative or non-finite counts (defensive)", () => {
    expect(amFeedbackBoost(-5)).toBe(1);
    expect(amFeedbackBoost(NaN)).toBe(1);
    expect(amFeedbackBoost(Infinity)).toBe(1);
  });

  it("scales log10 — 10 cites → ~1.31×, 100 cites → ~1.60×", () => {
    // 1 + 0.3 * log10(1 + 10) = 1 + 0.3 * log10(11) ≈ 1.3125
    expect(amFeedbackBoost(10)).toBeCloseTo(1.3125, 3);
    // 1 + 0.3 * log10(101) ≈ 1.6014
    expect(amFeedbackBoost(100)).toBeCloseTo(1.6014, 3);
  });

  it("is monotonic non-decreasing as citation_count grows", () => {
    const counts = [0, 1, 5, 10, 25, 100, 500, 1000];
    for (let i = 1; i < counts.length; i++) {
      expect(amFeedbackBoost(counts[i])).toBeGreaterThanOrEqual(
        amFeedbackBoost(counts[i - 1]),
      );
    }
  });

  it("caps boost at a reasonable ceiling — even 1000 cites stay below 2x", () => {
    // 1 + 0.3 * log10(1001) ≈ 1.9013 — well below 2x, prevents runaway.
    expect(amFeedbackBoost(1000)).toBeLessThan(2);
  });
});

describe("computeRankingScore — composite", () => {
  it("multiplies the three weights together", () => {
    const fresh = new Date();
    const fact = f({
      updated_at: fresh,
      confidence_state: "confirmed",
      source_type: "basesheet",
    });
    expect(computeRankingScore(fact)).toBeCloseTo(1 * 1 * 1, 2);
  });

  it("ranks a fresh BaseSheet-sourced confirmed fact above a stale AI-conversation candidate", () => {
    const winner = f({
      fact_id: "winner",
      updated_at: new Date(),
      confidence_state: "confirmed",
      source_type: "basesheet",
    });
    const loser = f({
      fact_id: "loser",
      updated_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000), // 120d old
      confidence_state: "candidate",
      source_type: "beacon_ai_conversation",
    });
    expect(computeRankingScore(winner)).toBeGreaterThan(
      computeRankingScore(loser),
    );
  });

  it("a freshly-extracted AM-typed fact can outrank an older BaseSheet one", () => {
    // Practical scenario: BaseSheet says owner is "John Doe" 90 days
    // ago; AM types in "Jane Doe" today. AM-typed (recent) should win
    // even though BaseSheet has higher source_trust.
    const baseSheet = f({
      fact_id: "bs",
      updated_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      confidence_state: "confirmed",
      source_type: "basesheet",
    });
    const amTyped = f({
      fact_id: "am",
      updated_at: new Date(),
      confidence_state: "confirmed",
      source_type: "manual",
    });
    // basesheet @ 90d: 1.0 * 1.0 * 0.5^1.5 ≈ 0.354
    // manual @ now: 0.95 * 1.0 * 1.0 = 0.95
    expect(computeRankingScore(amTyped)).toBeGreaterThan(
      computeRankingScore(baseSheet),
    );
  });
});

describe("resolveCluster — conflict resolution", () => {
  it("throws on empty input", () => {
    expect(() => resolveCluster([])).toThrow();
  });

  it("returns a single-element cluster as trivially authoritative", () => {
    const only = f({ fact_id: "only" });
    const result = resolveCluster([only]);
    expect(result.authoritative.fact_id).toBe("only");
    expect(result.superseded).toEqual([]);
    expect(result.scores.size).toBe(1);
  });

  it("picks the highest-scoring fact as authoritative", () => {
    const winner = f({
      fact_id: "winner",
      updated_at: new Date(),
      confidence_state: "confirmed",
      source_type: "basesheet",
    });
    const loser = f({
      fact_id: "loser",
      updated_at: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
      confidence_state: "candidate",
      source_type: "beacon_ai_conversation",
    });
    const result = resolveCluster([loser, winner]); // order shouldn't matter
    expect(result.authoritative.fact_id).toBe("winner");
    expect(result.superseded.map((s) => s.fact_id)).toEqual(["loser"]);
  });

  it("breaks ties deterministically by fact_id ascending", () => {
    // Two facts with identical scores — tie-break should be by
    // fact_id lex order. 'a' < 'z', so 'a' wins.
    const same = {
      updated_at: new Date(),
      confidence_state: "confirmed" as const,
      source_type: "manual",
    };
    const fa = f({ fact_id: "aaa", ...same });
    const fz = f({ fact_id: "zzz", ...same });
    const result = resolveCluster([fz, fa]);
    expect(result.authoritative.fact_id).toBe("aaa");
    expect(result.superseded[0].fact_id).toBe("zzz");
  });

  it("populates the scores map for every fact in the cluster", () => {
    const facts = [
      f({ fact_id: "a" }),
      f({ fact_id: "b" }),
      f({ fact_id: "c" }),
    ];
    const result = resolveCluster(facts);
    expect(result.scores.size).toBe(3);
    expect(result.scores.has("a")).toBe(true);
    expect(result.scores.has("b")).toBe(true);
    expect(result.scores.has("c")).toBe(true);
  });

  it("is stable across re-runs on the same input", () => {
    const facts = [
      f({
        fact_id: "x",
        updated_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        source_type: "manual",
      }),
      f({
        fact_id: "y",
        updated_at: new Date(),
        source_type: "customer_note",
      }),
      f({
        fact_id: "z",
        updated_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        source_type: "basesheet",
      }),
    ];
    const r1 = resolveCluster(facts);
    const r2 = resolveCluster(facts);
    expect(r1.authoritative.fact_id).toBe(r2.authoritative.fact_id);
    expect(r1.superseded.map((s) => s.fact_id)).toEqual(
      r2.superseded.map((s) => s.fact_id),
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * SMART-K4 followup — needs_parent_review cascade
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Look for a sql call whose strings include a marker substring. Matches
 * loosely across all template-string fragments so we don't depend on
 * exact whitespace. Returns undefined if no call matches.
 */
function findSqlCall(marker: string): SqlCall | undefined {
  return sqlCalls.find((c) => c.strings.join(" ").includes(marker));
}

describe("persistResolution — needs_parent_review cascade", () => {
  it("fires a cascade UPDATE for each loser keyed on derived_from", async () => {
    const winner = f({
      fact_id: "winner-id",
      source_type: "basesheet",
      updated_at: new Date(),
    });
    const loser = f({
      fact_id: "loser-id",
      source_type: "manual",
      updated_at: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    });
    const result = resolveCluster([winner, loser]);
    expect(result.authoritative.fact_id).toBe("winner-id");

    await persistResolution(result);

    // Two writes per loser: the supersede UPDATE + the cascade UPDATE.
    // Plus one winner UPDATE. Three total writes for a 1-loser cluster.
    const cascade = findSqlCall("needs_parent_review = true");
    expect(cascade).toBeDefined();
    // The cascade references the loser as the derived_from target.
    expect(cascade?.values).toContain(loser.fact_id);
  });

  it("only flags DIRECT children — no recursive cascade through grandchildren", async () => {
    // We can't query grandchildren without a real DB, but we can assert
    // the SQL the cascade emits is a plain UPDATE keyed on
    // derived_from = loser_id with no JOIN / WITH RECURSIVE / second
    // pass — i.e. the implementation is bounded by construction.
    const winner = f({ fact_id: "w", source_type: "basesheet" });
    const loser = f({
      fact_id: "L",
      source_type: "manual",
      updated_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    });
    await persistResolution(resolveCluster([winner, loser]));

    const cascade = findSqlCall("needs_parent_review = true");
    const sqlText = cascade?.strings.join(" ") ?? "";
    // No recursive flavors of the cascade.
    expect(sqlText.toLowerCase()).not.toContain("with recursive");
    expect(sqlText.toLowerCase()).not.toContain("join");
    // Single UPDATE on the loser id only.
    expect(sqlText).toContain("UPDATE beacon_brain_facts");
    expect(sqlText).toContain("derived_from =");
  });

  it("stamps a human-readable parent_review_reason on each cascade", async () => {
    const winner = f({ fact_id: "winner-uuid", source_type: "basesheet" });
    const loser = f({
      fact_id: "loser-uuid",
      source_type: "manual",
      updated_at: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    });
    await persistResolution(resolveCluster([winner, loser]));

    const cascade = findSqlCall("parent_review_reason");
    expect(cascade).toBeDefined();
    // The reason string includes both the loser id and the winner id —
    // it's the audit breadcrumb the Validate inbox renders.
    const reasonParam = cascade?.values.find(
      (v) => typeof v === "string" && (v as string).includes("superseded by"),
    ) as string | undefined;
    expect(reasonParam).toBeDefined();
    expect(reasonParam).toContain("loser-uuid");
    expect(reasonParam).toContain("winner-uuid");
  });

  it("skips the cascade for a single-element cluster (no losers)", async () => {
    const only = f({ fact_id: "solo", source_type: "manual" });
    await persistResolution(resolveCluster([only]));
    // Only the winner UPDATE fires; no cascade because no losers.
    expect(findSqlCall("needs_parent_review = true")).toBeUndefined();
  });
});
