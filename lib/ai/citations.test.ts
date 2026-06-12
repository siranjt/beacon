/**
 * Tests for the citation lookup builders — Roadmap-v2-4 scope.
 *
 * Focus: buildBrainProvenanceCitations, the helper that lifts hybrid
 * retrieval output into the per-fact `[cite:fact:<fact_id>]` lookup the
 * client passes to the continuation `ask` call. Other scope-builders
 * already have indirect coverage through compose tests; we don't
 * duplicate that here.
 */

import { describe, it, expect } from "vitest";
import {
  buildBrainProvenanceCitations,
  buildBrainStaticCitations,
} from "./citations";

function fact(over: Partial<Parameters<typeof buildBrainProvenanceCitations>[0]["facts"][number]> = {}) {
  return {
    fact_id: "fact-1",
    topic_category: "operational",
    topic_subcategory: "platform",
    field_name: "name",
    value: "GlossGenius",
    matched_via: ["embedding"] as Array<"embedding" | "keyword">,
    rrf_score: 0.0164,
    relevance_score: 0.78,
    source_type: "am_confirmed",
    confirmed_at: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

describe("buildBrainProvenanceCitations", () => {
  it("emits one entry per fact, keyed by `fact:<fact_id>`", () => {
    const lookup = buildBrainProvenanceCitations({
      facts: [
        fact({ fact_id: "f-aaa" }),
        fact({ fact_id: "f-bbb", value: "Square" }),
      ],
      candidatePoolSize: 12,
      query: "what platform are they on",
    });
    expect(Object.keys(lookup).sort()).toEqual([
      "fact:f-aaa",
      "fact:f-bbb",
    ]);
  });

  it("attaches provenance carrying rank derived from list order", () => {
    const lookup = buildBrainProvenanceCitations({
      facts: [
        fact({ fact_id: "first" }),
        fact({ fact_id: "second", relevance_score: 0.5 }),
        fact({ fact_id: "third", relevance_score: 0.3 }),
      ],
      candidatePoolSize: 47,
      query: null,
    });
    expect(lookup["fact:first"].provenance?.rank).toBe(1);
    expect(lookup["fact:second"].provenance?.rank).toBe(2);
    expect(lookup["fact:third"].provenance?.rank).toBe(3);
    expect(lookup["fact:third"].provenance?.candidate_pool_size).toBe(47);
  });

  it("preserves matched_via + rrf + rerank verbatim", () => {
    const lookup = buildBrainProvenanceCitations({
      facts: [
        fact({
          fact_id: "f1",
          matched_via: ["embedding", "keyword"],
          rrf_score: 0.0321,
          relevance_score: 0.91,
        }),
      ],
      candidatePoolSize: 5,
      query: "owner name",
    });
    const p = lookup["fact:f1"].provenance!;
    expect(p.matched_via).toEqual(["embedding", "keyword"]);
    expect(p.rrf_score).toBeCloseTo(0.0321);
    expect(p.rerank_score).toBe(0.91);
    expect(p.query).toBe("owner name");
  });

  it("threads relevance_score=null through as rerank_score=null (rerank skipped)", () => {
    const lookup = buildBrainProvenanceCitations({
      facts: [fact({ relevance_score: null })],
      candidatePoolSize: 3,
      query: null,
    });
    expect(lookup["fact:fact-1"].provenance?.rerank_score).toBe(null);
  });

  it("uses category='fact' and packs topic path into label + value", () => {
    const lookup = buildBrainProvenanceCitations({
      facts: [
        fact({
          fact_id: "abc",
          topic_category: "identity",
          topic_subcategory: "owner",
          field_name: "name",
          value: "Sarah Chen",
        }),
      ],
      candidatePoolSize: 1,
      query: null,
    });
    expect(lookup["fact:abc"].category).toBe("fact");
    expect(lookup["fact:abc"].label).toBe("identity/owner/name");
    expect(lookup["fact:abc"].value).toBe("Sarah Chen");
  });

  it("skips rows missing a fact_id", () => {
    const lookup = buildBrainProvenanceCitations({
      facts: [fact({ fact_id: "" }), fact({ fact_id: "real" })],
      candidatePoolSize: 2,
      query: null,
    });
    expect(Object.keys(lookup)).toEqual(["fact:real"]);
  });

  it("returns an empty lookup when facts is empty", () => {
    const lookup = buildBrainProvenanceCitations({
      facts: [],
      candidatePoolSize: 0,
      query: "anything",
    });
    expect(lookup).toEqual({});
  });
});

/**
 * WAVE-A-HOTFIX (2026-06-13) — Static Keeper citations land context-loaded
 * facts (loaded via loadBrainForPrompt at prompt-build time, NOT via hybrid
 * retrieval tool call) into the lookup. Without these entries the vault
 * chip falls through to (unverified) gray in CitationChip every time Beam
 * quotes the AE / contract / MRR fact already in CONTEXT.brain.
 */
describe("buildBrainStaticCitations", () => {
  it("emits one entry per fact_id, category 'fact', source_type 'keeper_static'", () => {
    const lookup = buildBrainStaticCitations({
      "f-aaa": {
        topic: "identity",
        subcategory: "sold_by_ae_info",
        field: "sold_by_ae",
        value: "Chandan Gowda",
      },
      "f-bbb": {
        topic: "operational",
        subcategory: "contract_terms",
        field: "mrr",
        value: "249",
      },
    });
    expect(Object.keys(lookup).sort()).toEqual(["fact:f-aaa", "fact:f-bbb"]);
    expect(lookup["fact:f-aaa"].category).toBe("fact");
    expect(lookup["fact:f-aaa"].value).toBe("Chandan Gowda");
    expect(lookup["fact:f-aaa"].label).toBe(
      "identity/sold_by_ae_info/sold_by_ae",
    );
    expect(lookup["fact:f-aaa"].raw?.source_type).toBe("keeper_static");
    // No provenance — static facts didn't go through rerank.
    expect(lookup["fact:f-aaa"].provenance).toBeUndefined();
  });

  it("returns an empty lookup when called with null / undefined", () => {
    expect(buildBrainStaticCitations(null)).toEqual({});
    expect(buildBrainStaticCitations(undefined)).toEqual({});
  });

  it("skips entries with an empty fact_id key", () => {
    const lookup = buildBrainStaticCitations({
      "": {
        topic: "identity",
        subcategory: null,
        field: null,
        value: "skip me",
      },
      "real-fact": {
        topic: "identity",
        subcategory: null,
        field: null,
        value: "keep me",
      },
    });
    expect(Object.keys(lookup)).toEqual(["fact:real-fact"]);
  });
});
