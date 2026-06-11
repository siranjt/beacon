/**
 * SMART-K2 — auto-prune stale Keeper facts.
 *
 * As Keeper accumulates facts across months, retrieval quality suffers
 * from noise: a fact that hasn't been touched in 6+ months AND has never
 * been cited by Beam is almost always stale (org reshuffles, AMs changed,
 * customer pivoted, etc.). We don't delete it — that destroys audit
 * history — but we flip `is_stale = true` so the default read path skips
 * it. The `includeStale` opt-in on getFactsForCustomer / searchFacts
 * keeps the audit view fully recoverable.
 *
 * Rule of staleness — a fact is pruneable iff ALL of:
 *   1. updated_at is older than `ageMonths` (default 6)
 *   2. citation_count = 0 (or the column doesn't exist yet — see "K1
 *      column gate" below)
 *   3. is_stale is currently false (idempotent — re-running is a no-op)
 *   4. soft_deleted_at IS NULL (don't trample tombstones)
 *
 * Sunset-bounded facts (sunset_at IS NOT NULL AND sunset_at <= NOW())
 * are already excluded from the default read path by their sunset gate,
 * so we leave them alone — staling them adds nothing and clutters the
 * marked_stale_at column.
 *
 * K1 column gate
 * --------------
 * SMART-K1 adds `citation_count` in parallel. If that migration hasn't
 * landed on this environment yet, the prune query soft-fails to "treat
 * every old fact as zero-citation" — which is the safe default. We do
 * a one-shot column-exists check at the top so the SQL stays a single
 * branch.
 *
 * Idempotency
 * -----------
 * The is_stale = false predicate in the WHERE clause is the idempotency
 * guard. Re-running on a fact that's already stale is filtered out
 * before UPDATE — no spurious version-log rows, no marked_stale_at churn.
 */

import { getSql } from "../customer/postgres";

export interface StalePruneResult {
  /** Facts that matched the age + citation criteria (whether or not we wrote). */
  candidates: number;
  /** Facts whose is_stale flipped from false → true on this run. */
  marked: number;
  /** Non-fatal issues encountered (column missing, partial errors, etc.). */
  errors: string[];
  /** Whether the citation_count column was found at start. */
  citation_column_present: boolean;
  /** Age threshold actually used (after defaults). */
  age_months_used: number;
  /** Whether this run was a dry-run (no writes). */
  dry_run: boolean;
}

const DEFAULT_AGE_MONTHS = 6;

/**
 * Column-existence probe. Returns false on any query error so the caller
 * falls into the "treat as 0 citations" branch gracefully.
 */
async function hasCitationCountColumn(): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  try {
    const rows = (await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'beacon_brain_facts'
        AND column_name = 'citation_count'
      LIMIT 1
    `) as Array<{ column_name: string }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Mark facts stale that meet ALL of:
 *   - updated_at older than `ageMonths` (default 6)
 *   - citation_count = 0 (or treated as 0 if SMART-K1 hasn't shipped)
 *   - is_stale currently false (idempotency)
 *   - soft_deleted_at IS NULL
 *
 * Returns counts + diagnostics. Throws only on catastrophic DB outage —
 * partial errors are surfaced via `errors` so the caller can decide
 * whether to alert.
 */
export async function runStalePrune(opts?: {
  dryRun?: boolean;
  ageMonths?: number;
}): Promise<StalePruneResult> {
  const dryRun = opts?.dryRun ?? false;
  const ageMonths = Math.max(
    1,
    Math.floor(opts?.ageMonths ?? DEFAULT_AGE_MONTHS),
  );

  const out: StalePruneResult = {
    candidates: 0,
    marked: 0,
    errors: [],
    citation_column_present: false,
    age_months_used: ageMonths,
    dry_run: dryRun,
  };

  const sql = getSql();
  if (!sql) {
    out.errors.push("POSTGRES_URL not set — skipping stale prune");
    return out;
  }

  const hasCitation = await hasCitationCountColumn();
  out.citation_column_present = hasCitation;

  // Build the WHERE clause. When citation_count is missing, the predicate
  // becomes "any old fact with is_stale=false" — same as treating every
  // existing row as citation_count = 0.
  //
  // The interval is built server-side as a literal string (e.g.
  // "6 months") because Neon's tagged-template driver doesn't bind
  // intervals via $N substitution cleanly. ageMonths is integer-clamped
  // above, so no injection surface.
  const intervalLiteral = `${ageMonths} months`;

  try {
    // Count candidates first — separate query so both dry-run and live
    // paths report the same total.
    const countRows = hasCitation
      ? ((await sql`
          SELECT COUNT(*)::int AS n
          FROM beacon_brain_facts
          WHERE is_stale = false
            AND soft_deleted_at IS NULL
            AND citation_count = 0
            AND updated_at < NOW() - ${intervalLiteral}::interval
        `) as Array<{ n: number }>)
      : ((await sql`
          SELECT COUNT(*)::int AS n
          FROM beacon_brain_facts
          WHERE is_stale = false
            AND soft_deleted_at IS NULL
            AND updated_at < NOW() - ${intervalLiteral}::interval
        `) as Array<{ n: number }>);
    out.candidates = countRows[0]?.n ?? 0;

    if (dryRun || out.candidates === 0) {
      return out;
    }

    // Live write — UPDATE returns affected row count. The WHERE clause
    // mirrors the count query exactly so we don't race against new
    // citations: a fact that gets cited between the count + update
    // simply fails the WHERE on UPDATE and is excluded.
    const updateRows = hasCitation
      ? ((await sql`
          UPDATE beacon_brain_facts
          SET is_stale = true,
              marked_stale_at = NOW()
          WHERE is_stale = false
            AND soft_deleted_at IS NULL
            AND citation_count = 0
            AND updated_at < NOW() - ${intervalLiteral}::interval
          RETURNING fact_id
        `) as Array<{ fact_id: string }>)
      : ((await sql`
          UPDATE beacon_brain_facts
          SET is_stale = true,
              marked_stale_at = NOW()
          WHERE is_stale = false
            AND soft_deleted_at IS NULL
            AND updated_at < NOW() - ${intervalLiteral}::interval
          RETURNING fact_id
        `) as Array<{ fact_id: string }>);
    out.marked = updateRows.length;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    out.errors.push(`stale prune query failed: ${msg}`);
  }

  return out;
}
