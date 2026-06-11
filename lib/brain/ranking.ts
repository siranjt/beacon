/**
 * Wave-2 (Beam/Keeper) — deterministic fact ranking for conflict resolution.
 *
 * When two facts in the same (customer, topic_subcategory, field_name)
 * cluster pass the Wave 2b semantic gate via force_semantic_conflict=true,
 * we now have two rows where the read path expects one. This module
 * computes a deterministic ranking score for each row in the cluster
 * and decides which is authoritative.
 *
 *   score = recency_weight * confidence_multiplier * source_trust
 *            * am_feedback_boost
 *
 * The schema-level effect:
 *   - winner: superseded_by = NULL (read path surfaces this row)
 *   - losers: superseded_by = winner.fact_id (read path hides by default)
 *   - all rows: ranking_score persisted for audit + tie-break
 *
 * SMART-K1: am_feedback_boost now lives. Citation count on each fact is
 * bumped fire-and-forget every time it surfaces through the hybrid
 * retrieval path (read_customer_brain / query_brain). The boost is
 * log10-scaled so a runaway popular fact can't dominate ranking —
 * caps at ~1.5× even with 100 cites. Facts with zero citations have
 * boost = 1.0 → backwards-compatible no-op on existing data.
 *
 * Why these specific weights:
 *   - 60-day half-life on recency means "we believe the new write
 *     more, but a freshly-confirmed BaseSheet fact from a quarter ago
 *     still outranks a noisy Haiku candidate from yesterday".
 *   - confidence at 0.3 for candidates means a candidate has to be
 *     >3x better on other dimensions to outrank a confirmed peer —
 *     conservative.
 *   - source_trust ordering matches our system-of-record hierarchy:
 *     BaseSheet/Chargebee (1.0) > AM-typed (0.95) > note-extracted
 *     (0.75) > Haiku-extracted (0.65) > Beam-conversation (0.55).
 */

import type { BrainFact, ConfidenceState } from "./types";
import { getSql } from "../customer/postgres";

/** Half-life for the recency exponential decay, in days. */
export const RECENCY_HALF_LIFE_DAYS = 60;

/* ────────────────────────────────────────────────────────────────────────
 * Pure scoring functions
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Exponential decay on the fact's updated_at timestamp.
 *
 *   recencyWeight = 0.5 ^ (days_since_update / 60)
 *
 * Pinned at [0, 1]. A just-now fact scores 1.0; one 60d old scores
 * 0.5; one 180d old scores 0.125.
 *
 * Robust to bad timestamps — returns 0 for unparseable input rather
 * than NaN, so downstream multiplication stays sane.
 */
export function recencyWeight(updated_at: string | Date | null): number {
  if (!updated_at) return 0;
  const t = updated_at instanceof Date ? updated_at.getTime() : Date.parse(String(updated_at));
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (days <= 0) return 1; // future-dated → treat as just-now
  return Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
}

/** Confirmed facts weigh ~3x more than candidates. */
export function confidenceMultiplier(state: ConfidenceState): number {
  return state === "confirmed" ? 1.0 : 0.3;
}

/**
 * Source-trust ordering. BaseSheet / Chargebee are the system of record
 * (auto-bootstrapped from authoritative third-party data). Manual AM
 * writes are the next tier — humans typing into the Keeper directly.
 * Then note-extracted (second-hand) and Haiku-extracted (inferred).
 * Beam-conversation is lowest because it's content the AI itself wrote.
 *
 * Unknown source_types fall to 0.5 so we don't accidentally promote
 * a misclassified row.
 */
export function sourceTrust(source_type: string): number {
  switch (source_type) {
    case "basesheet":
    case "chargebee":
      return 1.0;
    case "manual":
      return 0.95;
    case "customer_note":
      return 0.75;
    case "beacon_ai_extracted":
      return 0.65;
    case "beacon_ai_conversation":
      return 0.55;
    default:
      return 0.5;
  }
}

/**
 * SMART-K1 — log-scaled boost from accumulated AM citations.
 *
 *   amFeedbackBoost = 1 + 0.3 * log10(1 + citation_count)
 *
 * Calibration:
 *   -   0 cites → 1.00×   (no change — backwards-compatible default)
 *   -   1 cite  → ~1.09×
 *   -  10 cites → ~1.31×
 *   - 100 cites → ~1.60×
 *   -1000 cites → ~1.90×
 *
 * The log scale keeps a runaway-popular fact from dominating the score —
 * even an absurd 1000 citations still only ~1.9× boost, so source_trust
 * + recency continue to matter. Negative or non-finite inputs floor to
 * 0 (boost 1.0) to keep multiplication sane.
 */
export function amFeedbackBoost(citation_count: number): number {
  if (!Number.isFinite(citation_count) || citation_count <= 0) return 1;
  return 1 + 0.3 * Math.log10(1 + citation_count);
}

/**
 * Composite score for a single fact. Always in [0, 1] times the product
 * of the three weights, with the SMART-K1 am_feedback_boost layered on
 * top (boost ≥ 1, so it can only help — never demote). Returns the raw
 * numeric — caller persists to ranking_score and uses for ordering.
 */
export function computeRankingScore(fact: BrainFact): number {
  return (
    recencyWeight(fact.updated_at) *
    confidenceMultiplier(fact.confidence_state) *
    sourceTrust(fact.source_type) *
    amFeedbackBoost(fact.citation_count)
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Cluster resolution
 * ──────────────────────────────────────────────────────────────────────── */

export interface ResolutionResult {
  /** The fact that should be marked authoritative (superseded_by = NULL). */
  authoritative: BrainFact;
  /** Facts that should be marked as superseded_by = authoritative.fact_id. */
  superseded: BrainFact[];
  /** Score per fact_id, ready to persist to ranking_score. */
  scores: Map<string, number>;
}

/**
 * Given a cluster of facts (typically: an existing fact + a freshly-
 * written semantic-conflict twin, plus any earlier members of the
 * cluster chained via superseded_by), pick the authoritative one and
 * label the rest.
 *
 * Sorting is stable across re-runs:
 *   1. Highest ranking_score wins
 *   2. Ties broken by fact_id lexicographic order (arbitrary but stable)
 *
 * Throws on empty input — caller should never pass [].
 */
export function resolveCluster(facts: BrainFact[]): ResolutionResult {
  if (facts.length === 0) {
    throw new Error("[ranking] resolveCluster called with empty facts array");
  }

  const scored = facts.map((f) => ({
    fact: f,
    score: computeRankingScore(f),
  }));

  // Sort: score desc, then fact_id asc as deterministic tie-breaker.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.fact.fact_id < b.fact.fact_id ? -1 : 1;
  });

  const scoresMap = new Map<string, number>();
  for (const s of scored) scoresMap.set(s.fact.fact_id, s.score);

  return {
    authoritative: scored[0].fact,
    superseded: scored.slice(1).map((s) => s.fact),
    scores: scoresMap,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Persistence — walk the superseded_by chain, persist resolution
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Given any fact_id in a cluster, return every member of that cluster
 * (the authoritative head + every row whose superseded_by points at the
 * head). Walks the superseded_by chain up to a sensible cap (10) to find
 * the head; long chains shouldn't exist in practice but the cap prevents
 * runaway on a corrupted cycle.
 *
 * Excludes soft-deleted rows — they're audit-only history, not live
 * cluster members.
 *
 * Returns [] on any failure (no SQL, no such fact).
 */
export async function findClusterMembers(
  member_fact_id: string,
): Promise<BrainFact[]> {
  const sql = getSql();
  if (!sql) return [];

  // Walk to the head. Most chains are length 1-2 in practice.
  let cursor = member_fact_id;
  for (let i = 0; i < 10; i++) {
    const rows = (await sql`
      SELECT superseded_by FROM beacon_brain_facts
      WHERE fact_id = ${cursor}::uuid
      LIMIT 1
    `) as Array<{ superseded_by: string | null }>;
    if (rows.length === 0) return []; // unknown fact_id
    if (rows[0].superseded_by === null) break;
    cursor = rows[0].superseded_by;
  }

  const head_fact_id = cursor;
  const cluster = (await sql`
    SELECT * FROM beacon_brain_facts
    WHERE (fact_id = ${head_fact_id}::uuid OR superseded_by = ${head_fact_id}::uuid)
      AND soft_deleted_at IS NULL
  `) as BrainFact[];
  return cluster;
}

/**
 * Persist a resolution. Idempotent: re-running on a stable cluster
 * produces the same end state. Does NOT touch updated_at — that would
 * change the recency_weight on the next resolution and make the
 * winner non-deterministic across runs.
 *
 * Safe to call with a single-element cluster (no-op — single element
 * is trivially authoritative).
 */
export async function persistResolution(result: ResolutionResult): Promise<void> {
  const sql = getSql();
  if (!sql) return;

  const winnerId = result.authoritative.fact_id;
  const winnerScore = result.scores.get(winnerId) ?? 0;

  // Mark winner authoritative — superseded_by=NULL, persist its score.
  await sql`
    UPDATE beacon_brain_facts
    SET superseded_by = NULL,
        ranking_score = ${winnerScore}
    WHERE fact_id = ${winnerId}::uuid
  `;

  // Mark each loser as superseded_by = winner.
  for (const loser of result.superseded) {
    const score = result.scores.get(loser.fact_id) ?? 0;
    await sql`
      UPDATE beacon_brain_facts
      SET superseded_by = ${winnerId}::uuid,
          ranking_score = ${score}
      WHERE fact_id = ${loser.fact_id}::uuid
    `;
  }
}

/**
 * The end-to-end resolution entry point. Called from writeBrainFact
 * immediately after a force_semantic_conflict insert lands:
 *
 *   1. find the cluster (new fact + neighbor's authoritative head +
 *      everything else pointing at that head)
 *   2. score every member
 *   3. persist winner / losers
 *
 * The new fact's row is added to the cluster set even if the SQL
 * lookup races (the fresh INSERT might not be visible if the caller
 * uses transactional isolation — unlikely with Neon's autocommit but
 * cheap to belt-and-suspender).
 *
 * Soft-fails on any error — logs a warning and returns. A
 * resolution that doesn't run leaves both facts authoritative,
 * which is the pre-Wave-2 behavior — not great, but not data loss.
 */
export async function applyConflictResolution(opts: {
  new_fact: BrainFact;
  neighbor_fact_id: string;
}): Promise<ResolutionResult | null> {
  try {
    const cluster = await findClusterMembers(opts.neighbor_fact_id);
    if (cluster.length === 0) return null;

    // Belt-and-suspender: ensure the new fact is in the set, even if
    // the SQL fetch raced before the INSERT was visible.
    const merged = [...cluster];
    if (!merged.find((f) => f.fact_id === opts.new_fact.fact_id)) {
      merged.push(opts.new_fact);
    }

    const result = resolveCluster(merged);
    await persistResolution(result);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[ranking] applyConflictResolution failed: ${msg}`);
    return null;
  }
}
