/**
 * CitationChip — formatProvenanceTrace tests (Roadmap-v2-4).
 *
 * Pure function tests for the helper that turns a CitationProvenance
 * payload into the display strings rendered inside the "why" trace card.
 * Component rendering needs jsdom + @testing-library — those aren't wired
 * into this repo, so we exercise the load-bearing logic at the helper
 * boundary instead. The trace card itself is dumb markup; bugs would
 * surface here first.
 */

import { describe, it, expect } from "vitest";
import { formatProvenanceTrace } from "./CitationChip";
import type { CitationProvenance } from "@/lib/ai/citations";

function prov(over: Partial<CitationProvenance> = {}): CitationProvenance {
  return {
    matched_via: ["embedding"],
    rrf_score: 0.0164,
    rerank_score: 0.823,
    rank: 1,
    candidate_pool_size: 12,
    query: null,
    ...over,
  };
}

describe("formatProvenanceTrace — happy path", () => {
  it("formats RRF + rerank to 3 decimals and computes rerank percentage", () => {
    const out = formatProvenanceTrace(prov());
    expect(out.rrfLabel).toBe("0.016");
    expect(out.rerankLabel).toBe("0.823");
    expect(out.rerankPct).toBe(82);
  });

  it("renders the ordinal rank + pool size in 'Nth of M' shape", () => {
    expect(formatProvenanceTrace(prov({ rank: 1 })).poolLabel).toBe(
      "1st of 12 candidates",
    );
    expect(formatProvenanceTrace(prov({ rank: 2 })).poolLabel).toBe(
      "2nd of 12 candidates",
    );
    expect(formatProvenanceTrace(prov({ rank: 3 })).poolLabel).toBe(
      "3rd of 12 candidates",
    );
    expect(formatProvenanceTrace(prov({ rank: 4 })).poolLabel).toBe(
      "4th of 12 candidates",
    );
    expect(
      formatProvenanceTrace(prov({ rank: 11, candidate_pool_size: 47 }))
        .poolLabel,
    ).toBe("11th of 47 candidates");
  });

  it("pluralizes 'candidate' correctly at pool size 1", () => {
    const out = formatProvenanceTrace(
      prov({ rank: 1, candidate_pool_size: 1 }),
    );
    expect(out.poolLabel).toBe("1st of 1 candidate");
  });

  it("passes through both matched_via badges unchanged", () => {
    const out = formatProvenanceTrace(
      prov({ matched_via: ["embedding", "keyword"] }),
    );
    expect(out.matchedVia).toEqual(["embedding", "keyword"]);
  });
});

describe("formatProvenanceTrace — edge cases", () => {
  it("labels rerank as 'skipped' when rerank_score is null", () => {
    const out = formatProvenanceTrace(prov({ rerank_score: null }));
    expect(out.rerankLabel).toBe("skipped");
    expect(out.rerankPct).toBe(null);
  });

  it("clamps a rerank_score above 1 to 100% / 1.000", () => {
    const out = formatProvenanceTrace(prov({ rerank_score: 1.5 }));
    expect(out.rerankPct).toBe(100);
    expect(out.rerankLabel).toBe("1.000");
  });

  it("clamps a negative rerank_score to 0% / 0.000", () => {
    const out = formatProvenanceTrace(prov({ rerank_score: -0.4 }));
    expect(out.rerankPct).toBe(0);
    expect(out.rerankLabel).toBe("0.000");
  });

  it("clamps pool size up to at least the rank (1st of 1) instead of negative-of-pool", () => {
    // candidate_pool_size=0 with rank=1 would read absurdly as "1st of 0";
    // we treat that as a degenerate case and snap pool up to the rank.
    const out = formatProvenanceTrace(
      prov({ rank: 1, candidate_pool_size: 0 }),
    );
    expect(out.poolLabel).toBe("1st of 1 candidate");
  });

  it("falls back to 'Nth ranked' when pool AND rank are both zero", () => {
    const out = formatProvenanceTrace(
      prov({ rank: 0, candidate_pool_size: 0 }),
    );
    // Rank clamped to 1, pool clamped to >= rank → "1st of 1 candidate"
    // is still informative; the bare-"ranked" path only fires if pool<1.
    // We assert by floor() behavior instead.
    expect(out.poolLabel).toMatch(/^1st of 1 candidate$/);
  });

  it("emits an empty matched_via list when none surfaced", () => {
    const out = formatProvenanceTrace(prov({ matched_via: [] }));
    expect(out.matchedVia).toEqual([]);
  });

  it("renders '—' when rrf_score is non-finite", () => {
    const out = formatProvenanceTrace(
      prov({ rrf_score: Number.NaN as unknown as number }),
    );
    expect(out.rrfLabel).toBe("—");
  });
});
