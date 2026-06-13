/**
 * WAVE-B Keeper Question Bank — gap clustering primitives.
 *
 * Why this module exists
 * ----------------------
 * beacon_ai_failure_log accumulates one row per unresolved Beam gap. After
 * a couple weeks, the same customer surfaces 3-5 gaps that describe the
 * same missing fact in different words ("preferred contact channel",
 * "channel preference", "best way to reach owner"). Those are noise
 * individually but signal collectively — they're one question to the AM,
 * not three.
 *
 * This module turns a bag of gaps into clusters of "the same question
 * being asked over and over". The clustering is pure cosine-greedy over
 * Voyage embeddings — we don't k-means because we have no idea how many
 * underlying questions exist per customer, and greedy is good enough for
 * a min-3 cluster size (we want strong signal, not statistical purity).
 *
 * Pure module — no Postgres, no Voyage calls. The cron supplies the
 * embeddings; we just do the math. Keeps this trivially unit-testable.
 */

import { createHash } from "node:crypto";

/**
 * Cosine similarity between two equal-length number vectors.
 *
 * Returns 0 when either vector has zero magnitude (defensive — Voyage
 * shouldn't return zero vectors, but the math would NaN otherwise).
 * Returns 0 when the vectors have different lengths (rare embedding-
 * provider mismatch). Returns 1 for identical vectors, -1 for opposite.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export interface GapForClustering {
  id: bigint;
  description: string;
  embedding: number[];
}

export interface Cluster {
  /** Short stable hash so duplicate-cluster regen can be gated. */
  signature: string;
  /** All gap-log row ids that landed in this cluster. */
  ids: bigint[];
}

/**
 * Minimum cluster size. Anything below this is dropped — we don't want
 * Beam asking the AM about a one-off question that happened to land in
 * the log once.
 */
export const MIN_CLUSTER_SIZE = 3;

/**
 * Greedy single-pass clustering.
 *
 * Algorithm:
 *   1. Walk gaps in input order.
 *   2. For each gap not yet assigned, seed a new cluster with it.
 *   3. Sweep all remaining unassigned gaps; any with cosine ≥ threshold
 *      to the seed get folded into this cluster.
 *   4. After the sweep, emit the cluster only if its size meets MIN.
 *
 * This is O(N²) over gaps but N is bounded by the cron's 30-day window —
 * realistically ≤ low thousands of unresolved gaps even at scale, and
 * usually far fewer. We don't index because the win isn't worth the
 * memory churn for our N.
 *
 * The threshold defaults to 0.85 — slightly looser than the Wave 2b
 * dedup threshold (0.92) because we want to catch "similar question,
 * different phrasing" not "literal duplicate". Tunable by the caller
 * if early use shows clusters that are too tight or too loose.
 */
export function clusterGaps(
  gaps: GapForClustering[],
  threshold = 0.85,
): Cluster[] {
  const assigned = new Set<string>(); // index strings; bigint keys play badly with Set
  const out: Cluster[] = [];

  for (let i = 0; i < gaps.length; i++) {
    const seed = gaps[i];
    const seedKey = String(i);
    if (assigned.has(seedKey)) continue;
    if (!seed.embedding || seed.embedding.length === 0) continue;

    const ids: bigint[] = [seed.id];
    assigned.add(seedKey);

    for (let j = i + 1; j < gaps.length; j++) {
      const candidateKey = String(j);
      if (assigned.has(candidateKey)) continue;
      const candidate = gaps[j];
      if (!candidate.embedding || candidate.embedding.length === 0) continue;

      const sim = cosineSimilarity(seed.embedding, candidate.embedding);
      if (sim >= threshold) {
        ids.push(candidate.id);
        assigned.add(candidateKey);
      }
    }

    if (ids.length >= MIN_CLUSTER_SIZE) {
      out.push({ signature: clusterSignature(ids), ids });
    }
  }

  return out;
}

/**
 * Short stable hash of the cluster's source ids.
 *
 * Two requirements:
 *   - **Stable across permutations** — `[3, 1, 2]` and `[1, 2, 3]` must
 *     hash to the same value so duplicate detection works regardless of
 *     the order the gap rows came out of the database.
 *   - **Compact** — gets indexed as the pending-uniqueness key. 16 hex
 *     chars (~64 bits) is more than enough collision space for the
 *     volume of clusters we'll ever generate (low thousands per year).
 */
export function clusterSignature(ids: bigint[]): string {
  const sorted = [...ids].map((x) => x.toString()).sort();
  const h = createHash("sha256").update(sorted.join(",")).digest("hex");
  return h.slice(0, 16);
}
