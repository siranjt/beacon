/**
 * Spearman rank-correlation utility for the Voyage rerank A/B harness.
 *
 * We use this to compare the orderings produced by `rerank-2.5-lite` and
 * `rerank-2.5` (full) against the same RRF-merged candidate set. A high
 * coefficient means the two models agree on which facts belong at the top;
 * a low coefficient means the full model is moving the needle.
 *
 * Formula (rank-based Pearson, equivalent to Spearman's ρ):
 *
 *   ρ = 1 - (6 · Σ d_i²) / (n · (n² − 1))
 *
 * where:
 *   - n      = number of items shared between the two orderings
 *   - d_i    = (rank_in_A − rank_in_B) for the i-th shared item
 *   - ranks  = 1-indexed positions inside each ordering
 *
 * Notes:
 *   - We restrict to items present in BOTH orderings. The full rerank
 *     might keep only the top-K so its list is typically shorter — we
 *     only score the intersection.
 *   - If the intersection has fewer than 2 items, Spearman is undefined
 *     (n² − 1 = 0 for n=1, and trivially 1 for n=0). We return null in
 *     those cases so the caller can render "—" instead of a misleading
 *     1.0.
 *   - This is the "no-ties" simplified Spearman formula. Our inputs are
 *     ordered arrays of unique fact_ids, so ties cannot occur by
 *     construction.
 */

export function spearmanCorrelation(
  orderingA: string[],
  orderingB: string[],
): number | null {
  // Rank lookup tables (1-indexed).
  const rankA = new Map<string, number>();
  for (let i = 0; i < orderingA.length; i++) {
    rankA.set(orderingA[i], i + 1);
  }
  const rankB = new Map<string, number>();
  for (let i = 0; i < orderingB.length; i++) {
    rankB.set(orderingB[i], i + 1);
  }

  // Intersection only — we score the items both orderings included.
  const shared: string[] = [];
  for (const id of orderingA) {
    if (rankB.has(id)) shared.push(id);
  }

  const n = shared.length;
  if (n < 2) return null;

  let sumDSquared = 0;
  for (const id of shared) {
    const ra = rankA.get(id)!;
    const rb = rankB.get(id)!;
    const d = ra - rb;
    sumDSquared += d * d;
  }

  const denom = n * (n * n - 1);
  if (denom === 0) return null;
  return 1 - (6 * sumDSquared) / denom;
}
