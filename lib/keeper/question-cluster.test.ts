/**
 * WAVE-B Keeper Question Bank — clustering tests.
 *
 * Covers the four contract guarantees:
 *   1. Cosine math is sane (orthogonal=0, identical=1)
 *   2. 5 mutually-similar gaps fold into ONE cluster of 5
 *   3. A mix of 2 similar + 2 unrelated produces NO cluster (below MIN=3)
 *   4. The signature is stable across permutations of the same id set
 */

import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  clusterGaps,
  clusterSignature,
  MIN_CLUSTER_SIZE,
  type GapForClustering,
} from "./question-cluster";

// Convenience: a 1024-dim vector that lives entirely along one axis.
function axisVec(axis: number, dim = 8): number[] {
  const v = new Array<number>(dim).fill(0);
  v[axis % dim] = 1;
  return v;
}

// Small jitter to keep cosine just above the 0.85 default threshold while
// staying short of literal duplication.
function jitter(base: number[], scale = 0.05): number[] {
  return base.map((x, i) => x + (i % 2 === 0 ? scale : -scale));
}

describe("cosineSimilarity", () => {
  it("returns 0 for orthogonal vectors", () => {
    const a = axisVec(0);
    const b = axisVec(1);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("returns 1 for identical vectors", () => {
    const v = [0.3, 0.4, 0.5, 0.6];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it("returns ~1 for near-duplicates", () => {
    const base = [0.1, 0.2, 0.3, 0.4, 0.5];
    const near = base.map((x) => x + 0.001);
    expect(cosineSimilarity(base, near)).toBeGreaterThan(0.99);
  });

  it("returns 0 for empty or mismatched vectors (defensive)", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });
});

describe("clusterGaps", () => {
  it("folds 5 similar gaps into one cluster of 5", () => {
    const base = axisVec(0);
    const gaps: GapForClustering[] = [
      { id: 1n, description: "channel preference unknown", embedding: base },
      {
        id: 2n,
        description: "preferred contact channel undefined",
        embedding: jitter(base, 0.01),
      },
      {
        id: 3n,
        description: "no signal on best contact medium",
        embedding: jitter(base, 0.02),
      },
      {
        id: 4n,
        description: "channel ambiguity for this customer",
        embedding: jitter(base, 0.03),
      },
      {
        id: 5n,
        description: "owner channel preference not captured",
        embedding: jitter(base, 0.04),
      },
    ];
    const clusters = clusterGaps(gaps);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].ids).toHaveLength(5);
    expect(clusters[0].ids).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(clusters[0].signature).toHaveLength(16);
  });

  it("yields no clusters when only 2 gaps are similar (below MIN=3)", () => {
    expect(MIN_CLUSTER_SIZE).toBe(3);
    const a = axisVec(0);
    const b = axisVec(1);
    const c = axisVec(2);
    const d = axisVec(3);
    const gaps: GapForClustering[] = [
      { id: 10n, description: "x", embedding: a },
      { id: 11n, description: "x'", embedding: jitter(a, 0.01) },
      { id: 12n, description: "y", embedding: b },
      { id: 13n, description: "z", embedding: c },
      { id: 14n, description: "w", embedding: d },
    ];
    const clusters = clusterGaps(gaps);
    expect(clusters).toEqual([]);
  });

  it("isolates orthogonal seeds into their own (sub-MIN) buckets and drops them", () => {
    const gaps: GapForClustering[] = [
      { id: 1n, description: "a1", embedding: axisVec(0) },
      { id: 2n, description: "a2", embedding: axisVec(0) },
      { id: 3n, description: "a3", embedding: axisVec(0) },
      { id: 4n, description: "b1", embedding: axisVec(1) },
      { id: 5n, description: "b2", embedding: axisVec(1) },
    ];
    const clusters = clusterGaps(gaps);
    // First seed picks up its 2 duplicates → cluster of 3 (kept).
    // Second seed only has 1 partner → sub-MIN, dropped.
    expect(clusters).toHaveLength(1);
    expect(clusters[0].ids).toEqual([1n, 2n, 3n]);
  });
});

describe("clusterSignature", () => {
  it("is stable across permutations of the same id set", () => {
    const a = clusterSignature([1n, 2n, 3n]);
    const b = clusterSignature([3n, 1n, 2n]);
    const c = clusterSignature([2n, 3n, 1n]);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("differs for different id sets", () => {
    expect(clusterSignature([1n, 2n, 3n])).not.toBe(clusterSignature([1n, 2n, 4n]));
  });

  it("emits a fixed-length compact hash", () => {
    expect(clusterSignature([1n])).toHaveLength(16);
    expect(clusterSignature([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n])).toHaveLength(16);
  });
});
