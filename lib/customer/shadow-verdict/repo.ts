/**
 * Shadow verdict — Postgres repo. Phase SV.
 */

import "server-only";
import { getSql } from "@/lib/customer/postgres";
import type {
  PrimaryDriver,
  ShadowVerdictRow,
  Tier,
  TierFeedbackRow,
} from "./types";

/** Slim shape surfaced on V2CustomerCard (SV-10). The full ShadowVerdictRow is
 *  ~25 fields; we only need three for the in-card "AI says" chip. */
export interface LatestShadowVerdict {
  tier: Tier;
  run_date: string;            // YYYY-MM-DD
  primary_driver: PrimaryDriver;
}

/** Idempotent UPSERT on (run_date, entity_id). Re-running for the same
 *  day overwrites the prior row (latest LLM judgment wins). */
export async function upsertShadowVerdict(row: Omit<ShadowVerdictRow, "id" | "created_at">): Promise<string | null> {
  const sql = getSql();
  if (!sql) return null;
  const out = (await sql`
    INSERT INTO beacon_shadow_verdict (
      run_date, entity_id, am_name, am_email, bizname,
      deterministic_tier, deterministic_composite, deterministic_signal_summary,
      llm_tier, llm_confidence, llm_reasoning, llm_primary_driver,
      llm_retention_window_months, llm_key_signals, llm_disagreement_self_flag,
      agreement, drift_severity,
      raw_llm_response, haiku_input_tokens, haiku_output_tokens, elapsed_ms
    ) VALUES (
      ${row.run_date}, ${row.entity_id}, ${row.am_name}, ${row.am_email}, ${row.bizname},
      ${row.deterministic_tier}, ${row.deterministic_composite}, ${row.deterministic_signal_summary},
      ${row.llm_tier}, ${row.llm_confidence}, ${row.llm_reasoning}, ${row.llm_primary_driver},
      ${row.llm_retention_window_months}, ${JSON.stringify(row.llm_key_signals)}::jsonb, ${row.llm_disagreement_self_flag},
      ${row.agreement}, ${row.drift_severity},
      ${row.raw_llm_response ? JSON.stringify(row.raw_llm_response) : null}::jsonb,
      ${row.haiku_input_tokens}, ${row.haiku_output_tokens}, ${row.elapsed_ms}
    )
    ON CONFLICT (run_date, entity_id) DO UPDATE SET
      am_name = EXCLUDED.am_name,
      am_email = EXCLUDED.am_email,
      bizname = EXCLUDED.bizname,
      deterministic_tier = EXCLUDED.deterministic_tier,
      deterministic_composite = EXCLUDED.deterministic_composite,
      deterministic_signal_summary = EXCLUDED.deterministic_signal_summary,
      llm_tier = EXCLUDED.llm_tier,
      llm_confidence = EXCLUDED.llm_confidence,
      llm_reasoning = EXCLUDED.llm_reasoning,
      llm_primary_driver = EXCLUDED.llm_primary_driver,
      llm_retention_window_months = EXCLUDED.llm_retention_window_months,
      llm_key_signals = EXCLUDED.llm_key_signals,
      llm_disagreement_self_flag = EXCLUDED.llm_disagreement_self_flag,
      agreement = EXCLUDED.agreement,
      drift_severity = EXCLUDED.drift_severity,
      raw_llm_response = EXCLUDED.raw_llm_response,
      haiku_input_tokens = EXCLUDED.haiku_input_tokens,
      haiku_output_tokens = EXCLUDED.haiku_output_tokens,
      elapsed_ms = EXCLUDED.elapsed_ms
    RETURNING id
  `) as Array<{ id: string }>;
  return out[0]?.id ?? null;
}

/** Today's verdicts (or any given date). Used by the admin page. */
export async function listVerdictsForDate(date: string, limit: number = 1000): Promise<ShadowVerdictRow[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = (await sql`
    SELECT * FROM beacon_shadow_verdict
    WHERE run_date = ${date}
    ORDER BY drift_severity DESC, llm_confidence DESC
    LIMIT ${limit}
  `) as ShadowVerdictRow[];
  return rows;
}

/** Daily agreement-rate trend for the admin page top strip. */
export async function getAgreementTrend(days: number = 28): Promise<
  Array<{ run_date: string; total: number; agreed: number; agreement_pct: number }>
> {
  const sql = getSql();
  if (!sql) return [];
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = (await sql`
    SELECT
      run_date::text AS run_date,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE agreement)::int AS agreed
    FROM beacon_shadow_verdict
    WHERE run_date >= ${sinceStr}
    GROUP BY run_date
    ORDER BY run_date ASC
  `) as Array<{ run_date: string; total: number; agreed: number }>;
  return rows.map((r) => ({
    ...r,
    agreement_pct: r.total === 0 ? 0 : Math.round((r.agreed / r.total) * 100),
  }));
}

/** Drift-severity histogram for the admin top strip. */
export async function getDriftHistogram(date: string): Promise<{ agree: number; adjacent: number; skip: number }> {
  const sql = getSql();
  if (!sql) return { agree: 0, adjacent: 0, skip: 0 };
  const rows = (await sql`
    SELECT drift_severity, COUNT(*)::int AS n
    FROM beacon_shadow_verdict
    WHERE run_date = ${date}
    GROUP BY drift_severity
  `) as Array<{ drift_severity: number; n: number }>;
  const out = { agree: 0, adjacent: 0, skip: 0 };
  for (const r of rows) {
    if (r.drift_severity === 0) out.agree = r.n;
    else if (r.drift_severity === 1) out.adjacent = r.n;
    else if (r.drift_severity === 2) out.skip = r.n;
  }
  return out;
}

/** Verdict time series for a single entity — has the LLM flip-flopped? */
export async function getEntityVerdictHistory(entityId: string, days: number = 28): Promise<
  Array<{
    run_date: string;
    deterministic_tier: Tier;
    llm_tier: Tier;
    agreement: boolean;
    drift_severity: number;
  }>
> {
  const sql = getSql();
  if (!sql) return [];
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = (await sql`
    SELECT
      run_date::text AS run_date,
      deterministic_tier,
      llm_tier,
      agreement,
      drift_severity
    FROM beacon_shadow_verdict
    WHERE entity_id = ${entityId} AND run_date >= ${sinceStr}
    ORDER BY run_date ASC
  `) as Array<{
    run_date: string;
    deterministic_tier: Tier;
    llm_tier: Tier;
    agreement: boolean;
    drift_severity: number;
  }>;
  return rows;
}

/** Stability metric: for each entity, % of consecutive days where LLM
 *  verdict didn't change. Higher = more stable. Computed in SQL via
 *  LAG window. */
export async function getStabilityMetrics(days: number = 14): Promise<{
  total_entities: number;
  avg_stability_pct: number;
}> {
  const sql = getSql();
  if (!sql) return { total_entities: 0, avg_stability_pct: 0 };
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = (await sql`
    WITH paired AS (
      SELECT
        entity_id,
        llm_tier,
        LAG(llm_tier) OVER (PARTITION BY entity_id ORDER BY run_date) AS prev_llm_tier
      FROM beacon_shadow_verdict
      WHERE run_date >= ${sinceStr}
    ),
    per_entity AS (
      SELECT
        entity_id,
        COUNT(*) FILTER (WHERE prev_llm_tier IS NOT NULL) AS pairs,
        COUNT(*) FILTER (WHERE prev_llm_tier IS NOT NULL AND llm_tier = prev_llm_tier) AS stable_pairs
      FROM paired
      GROUP BY entity_id
    )
    SELECT
      COUNT(*)::int AS total_entities,
      COALESCE(AVG(CASE WHEN pairs > 0 THEN (stable_pairs::float / pairs) * 100 END), 0)::int AS avg_stability_pct
    FROM per_entity
  `) as Array<{ total_entities: number; avg_stability_pct: number }>;
  return rows[0] ?? { total_entities: 0, avg_stability_pct: 0 };
}

// ─────────────────────────────────────────────────────────────────────────
// AM tier feedback
// ─────────────────────────────────────────────────────────────────────────

export async function upsertTierFeedback(input: {
  entity_id: string;
  am_email: string;
  observed_tier: Tier;
  is_accurate: boolean;
  reason: string | null;
}): Promise<void> {
  const sql = getSql();
  if (!sql) return;
  await sql`
    INSERT INTO beacon_tier_feedback (
      feedback_date, entity_id, am_email, observed_tier, is_accurate, reason
    ) VALUES (
      CURRENT_DATE, ${input.entity_id}, ${input.am_email},
      ${input.observed_tier}, ${input.is_accurate}, ${input.reason}
    )
    ON CONFLICT (feedback_date, entity_id, am_email) DO UPDATE SET
      observed_tier = EXCLUDED.observed_tier,
      is_accurate = EXCLUDED.is_accurate,
      reason = EXCLUDED.reason,
      updated_at = now()
  `;
}

export async function getTodaysFeedbackForAm(amEmail: string): Promise<TierFeedbackRow[]> {
  const sql = getSql();
  if (!sql) return [];
  return (await sql`
    SELECT * FROM beacon_tier_feedback
    WHERE am_email = ${amEmail} AND feedback_date = CURRENT_DATE
  `) as TierFeedbackRow[];
}

/** Aggregate feedback over the last N days — fed into the week-5 decision. */
export async function getFeedbackAggregates(days: number = 28): Promise<{
  total_votes: number;
  accurate_votes: number;
  accuracy_pct: number;
  by_tier: Record<Tier, { total: number; accurate: number; accuracy_pct: number }>;
}> {
  const sql = getSql();
  if (!sql) {
    return {
      total_votes: 0,
      accurate_votes: 0,
      accuracy_pct: 0,
      by_tier: {
        RED: { total: 0, accurate: 0, accuracy_pct: 0 },
        YELLOW: { total: 0, accurate: 0, accuracy_pct: 0 },
        GREEN: { total: 0, accurate: 0, accuracy_pct: 0 },
      },
    };
  }
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  const overall = (await sql`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_accurate)::int AS accurate
    FROM beacon_tier_feedback
    WHERE feedback_date >= ${sinceStr}
  `) as Array<{ total: number; accurate: number }>;
  const byTier = (await sql`
    SELECT observed_tier, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_accurate)::int AS accurate
    FROM beacon_tier_feedback
    WHERE feedback_date >= ${sinceStr}
    GROUP BY observed_tier
  `) as Array<{ observed_tier: Tier; total: number; accurate: number }>;

  const total = overall[0]?.total ?? 0;
  const accurate = overall[0]?.accurate ?? 0;
  const by_tier: Record<Tier, { total: number; accurate: number; accuracy_pct: number }> = {
    RED: { total: 0, accurate: 0, accuracy_pct: 0 },
    YELLOW: { total: 0, accurate: 0, accuracy_pct: 0 },
    GREEN: { total: 0, accurate: 0, accuracy_pct: 0 },
  };
  for (const r of byTier) {
    by_tier[r.observed_tier] = {
      total: r.total,
      accurate: r.accurate,
      accuracy_pct: r.total === 0 ? 0 : Math.round((r.accurate / r.total) * 100),
    };
  }
  return {
    total_votes: total,
    accurate_votes: accurate,
    accuracy_pct: total === 0 ? 0 : Math.round((accurate / total) * 100),
    by_tier,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// SV-10 — surface latest LLM verdict on V2CustomerCard
// ─────────────────────────────────────────────────────────────────────────

/**
 * Map of entity_id → latest shadow verdict (one row per entity, the most
 * recent `run_date`). Used by /api/v2/snapshot to enrich each customer with
 * its current SV tier so the V2CustomerCard can render the "AI says" chip
 * without a per-card fetch.
 *
 * The query uses DISTINCT ON to pick the most recent run per entity in a
 * single round-trip.
 */
export async function getLatestShadowVerdictMap(): Promise<Map<string, LatestShadowVerdict>> {
  const map = new Map<string, LatestShadowVerdict>();
  const sql = getSql();
  if (!sql) return map;
  const rows = (await sql`
    SELECT DISTINCT ON (entity_id)
      entity_id,
      llm_tier,
      llm_primary_driver,
      run_date::text AS run_date
    FROM beacon_shadow_verdict
    ORDER BY entity_id, run_date DESC
  `) as Array<{
    entity_id: string;
    llm_tier: Tier;
    llm_primary_driver: PrimaryDriver;
    run_date: string;
  }>;
  for (const r of rows) {
    map.set(r.entity_id, {
      tier: r.llm_tier,
      run_date: r.run_date,
      primary_driver: r.llm_primary_driver,
    });
  }
  return map;
}
