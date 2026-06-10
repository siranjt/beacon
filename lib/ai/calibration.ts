/**
 * Beam confidence calibration — Roadmap-v2-1.
 *
 * Beam emits `<confidence: NN%>` markers on most assistant turns; the
 * AskPanel parses the percent and bins it into high/medium/low. Until now
 * we've claimed calibration but never measured whether the tiers actually
 * correlate with thumbs-up vs thumbs-down outcomes.
 *
 * This module reads beacon_ai_feedback (with the `confidence_tier` column
 * added in `2026-06-10-beacon-ai-feedback-confidence-tier.sql`) and rolls
 * up per-tier counts of up vs down, plus a derived hit rate. The admin
 * page at /admin/beacon-ai-calibration renders the result across 7d / 30d
 * / all-time windows and breaks it down per scope (joined off
 * beacon_ai_conversations.scope_key on turn_id).
 *
 * A well-calibrated Beam shows a monotonic curve:
 *   low hit rate < medium hit rate < high hit rate
 * with 'high' landing in the high-70s to high-90s range. If high tracks at
 * 50% something is broken — Beam is asserting confidence it hasn't earned.
 */

import { getSql } from "../customer/postgres";

export type CalibrationTier = "high" | "medium" | "low" | "null";

export interface TierStat {
  up: number;
  down: number;
  /**
   * up / (up + down). null when (up + down) === 0 — drawing 0% when no
   * one has voted in this bucket is misleading. The UI renders an em-dash.
   */
  rate: number | null;
}

export type TierStats = Record<CalibrationTier, TierStat>;

export interface ScopeCalibration {
  scope_key: string;
  stats: TierStats;
}

export interface CalibrationStats {
  overall: TierStats;
  by_scope: ScopeCalibration[];
}

const EMPTY_TIER: TierStat = { up: 0, down: 0, rate: null };

function emptyTierStats(): TierStats {
  return {
    high: { ...EMPTY_TIER },
    medium: { ...EMPTY_TIER },
    low: { ...EMPTY_TIER },
    null: { ...EMPTY_TIER },
  };
}

/** Normalize a DB tier value (text or null) into our CalibrationTier key. */
function normalizeTier(raw: unknown): CalibrationTier {
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  return "null";
}

function applyRow(
  stats: TierStats,
  tier: CalibrationTier,
  signal: "up" | "down",
  count: number,
): void {
  const slot = stats[tier];
  if (signal === "up") slot.up += count;
  else slot.down += count;
}

function finalizeRates(stats: TierStats): void {
  (Object.keys(stats) as CalibrationTier[]).forEach((k) => {
    const slot = stats[k];
    const total = slot.up + slot.down;
    slot.rate = total > 0 ? slot.up / total : null;
  });
}

interface AggregateRow {
  tier: unknown;
  signal: unknown;
  scope_key: unknown;
  cnt: unknown;
}

/**
 * Aggregate feedback rows into per-tier hit-rate buckets, with an
 * optional time window (days). Joins beacon_ai_conversations to derive
 * the scope of each turn — there's no scope_key column on beacon_ai_feedback
 * itself (the originating turn is the source of truth).
 *
 * Returns zero-filled empty stats if the DB isn't reachable or the
 * query errors. We don't want a broken admin page on a downed DB.
 */
export async function getCalibrationStats(opts: {
  windowDays?: number;
} = {}): Promise<CalibrationStats> {
  const sql = getSql();
  const empty: CalibrationStats = { overall: emptyTierStats(), by_scope: [] };
  if (!sql) return empty;

  const windowDays =
    typeof opts.windowDays === "number" && Number.isFinite(opts.windowDays)
      ? Math.max(1, Math.floor(opts.windowDays))
      : null;

  try {
    // GROUP BY the three dimensions in a single round trip; we split into
    // overall + by_scope in JS. Cheaper than firing two queries with
    // different group-by lists.
    const rows = (await sql`
      SELECT
        f.confidence_tier AS tier,
        f.signal          AS signal,
        c.scope_key       AS scope_key,
        COUNT(*)::int     AS cnt
      FROM beacon_ai_feedback f
      LEFT JOIN beacon_ai_conversations c ON c.id = f.turn_id
      WHERE (${windowDays}::int IS NULL
             OR f.created_at >= NOW() - (${windowDays} || ' days')::interval)
      GROUP BY f.confidence_tier, f.signal, c.scope_key
    `) as unknown as AggregateRow[];

    const overall = emptyTierStats();
    const byScopeMap = new Map<string, TierStats>();

    for (const r of rows) {
      const tier = normalizeTier(r.tier);
      const signal = r.signal === "up" || r.signal === "down" ? r.signal : null;
      if (!signal) continue;
      const count = typeof r.cnt === "number" ? r.cnt : Number(r.cnt) || 0;
      if (count <= 0) continue;
      const scopeKey =
        typeof r.scope_key === "string" && r.scope_key
          ? r.scope_key
          : "(unknown)";

      applyRow(overall, tier, signal, count);

      let scopeStats = byScopeMap.get(scopeKey);
      if (!scopeStats) {
        scopeStats = emptyTierStats();
        byScopeMap.set(scopeKey, scopeStats);
      }
      applyRow(scopeStats, tier, signal, count);
    }

    finalizeRates(overall);
    const by_scope: ScopeCalibration[] = [];
    byScopeMap.forEach((stats, scope_key) => {
      finalizeRates(stats);
      by_scope.push({ scope_key, stats });
    });
    // Sort scopes by total volume desc so the highest-traffic surfaces sit
    // at the top of the per-scope table.
    by_scope.sort((a, b) => totalVotes(b.stats) - totalVotes(a.stats));

    return { overall, by_scope };
  } catch (err) {
    console.error("[calibration] getCalibrationStats failed", err);
    return empty;
  }
}

export function totalVotes(stats: TierStats): number {
  return (
    stats.high.up +
    stats.high.down +
    stats.medium.up +
    stats.medium.down +
    stats.low.up +
    stats.low.down +
    stats.null.up +
    stats.null.down
  );
}
