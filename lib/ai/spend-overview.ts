/**
 * META-A5 — Anthropic spend overview builder.
 *
 * Shared between the admin page (server component) and the JSON API
 * endpoint, both of which compute the same rollups. Lives in lib/ so it
 * doesn't trip the "no imports across agent route groups" eslint rule.
 *
 * Numbers come from our own `beacon_anthropic_spend_log` table populated
 * by `lib/ai/spend-log.ts` at every Anthropic call site.
 */

import { getSql } from "@/lib/customer/postgres";

export interface SpendDaily {
  day: string; // YYYY-MM-DD (UTC)
  cost_usd: number;
  call_count: number;
}

export interface SpendByFeature {
  feature: string;
  cost_usd: number;
  call_count: number;
}

export interface SpendByModel {
  model: string;
  cost_usd: number;
  call_count: number;
}

export interface SpendOverview {
  /** Sum of cost_usd for the current calendar month (UTC). */
  mtd_usd: number;
  /** Linear projection: mtd_usd / days_elapsed * days_in_month. */
  projected_eom_usd: number;
  /** Today's running total (UTC). */
  today_usd: number;
  /** Number of days elapsed in current month (today inclusive). */
  days_elapsed: number;
  /** Total days in current month. */
  days_in_month: number;
  /** Alert state — surfaces a banner on the dashboard. */
  alert_state: "ok" | "warn" | "critical";
  alert_reason: string | null;
  daily: SpendDaily[];
  per_feature: SpendByFeature[];
  per_model: SpendByModel[];
}

const PROJECTED_CRITICAL_USD = 100; // $100 monthly cap target
const ACTUAL_WARN_USD = 90; // already 90% of cap

/**
 * Build the full overview payload. Returns an empty/zero payload when
 * POSTGRES_URL is unset (local dev with no Neon).
 */
export async function buildSpendOverview(): Promise<SpendOverview> {
  const sql = getSql();
  const now = new Date();
  const daysInMonth = new Date(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    0,
  ).getUTCDate();
  const daysElapsed = now.getUTCDate(); // 1-based, today inclusive

  if (!sql) {
    return {
      mtd_usd: 0,
      projected_eom_usd: 0,
      today_usd: 0,
      days_elapsed: daysElapsed,
      days_in_month: daysInMonth,
      alert_state: "ok",
      alert_reason: null,
      daily: [],
      per_feature: [],
      per_model: [],
    };
  }

  // Run the five aggregates in parallel — they all hit the same indexed
  // table and complete in tens of ms on Neon's serverless tier. Neon's
  // tagged template returns `NeonQueryPromise<Record<string, any>[]>`,
  // so we cast each result through `unknown` to our concrete row shapes.
  const [mtdRowsRaw, todayRowsRaw, dailyRowsRaw, featureRowsRaw, modelRowsRaw] =
    await Promise.all([
      sql`
        SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
          FROM beacon_anthropic_spend_log
         WHERE ts >= date_trunc('month', NOW())
      `,
      sql`
        SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
          FROM beacon_anthropic_spend_log
         WHERE ts >= date_trunc('day', NOW())
      `,
      sql`
        SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS day,
               COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
               COUNT(*)::int AS call_count
          FROM beacon_anthropic_spend_log
         WHERE ts >= NOW() - INTERVAL '30 days'
         GROUP BY date_trunc('day', ts)
         ORDER BY date_trunc('day', ts) ASC
      `,
      sql`
        SELECT feature,
               COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
               COUNT(*)::int AS call_count
          FROM beacon_anthropic_spend_log
         WHERE ts >= date_trunc('month', NOW())
         GROUP BY feature
         ORDER BY cost_usd DESC
      `,
      sql`
        SELECT model,
               COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
               COUNT(*)::int AS call_count
          FROM beacon_anthropic_spend_log
         WHERE ts >= date_trunc('month', NOW())
         GROUP BY model
         ORDER BY cost_usd DESC
      `,
    ]);
  const mtdRows = mtdRowsRaw as unknown as Array<{ total: number }>;
  const todayRows = todayRowsRaw as unknown as Array<{ total: number }>;
  const dailyRows = dailyRowsRaw as unknown as Array<{
    day: string;
    cost_usd: number;
    call_count: number;
  }>;
  const featureRows = featureRowsRaw as unknown as Array<{
    feature: string;
    cost_usd: number;
    call_count: number;
  }>;
  const modelRows = modelRowsRaw as unknown as Array<{
    model: string;
    cost_usd: number;
    call_count: number;
  }>;

  const mtdUsd = mtdRows[0]?.total ?? 0;
  const todayUsd = todayRows[0]?.total ?? 0;
  // Conservative linear projection: pace = mtd / days elapsed; project to
  // end of month at that pace. If days_elapsed is 0 (shouldn't happen, but
  // guard), fall back to mtd.
  const dailyRate = daysElapsed > 0 ? mtdUsd / daysElapsed : 0;
  const projectedEomUsd = dailyRate * daysInMonth;

  // Alert state — the user's cap is $100-120. We want to flag at $90
  // actual OR $100 projected so they have at least a few days of runway
  // to investigate.
  let alertState: "ok" | "warn" | "critical" = "ok";
  let alertReason: string | null = null;
  if (mtdUsd > ACTUAL_WARN_USD) {
    alertState = "critical";
    alertReason = `Month-to-date spend is $${mtdUsd.toFixed(2)} — over the $${ACTUAL_WARN_USD} actual warning threshold.`;
  } else if (projectedEomUsd > PROJECTED_CRITICAL_USD) {
    alertState = "warn";
    alertReason = `Projected end-of-month spend is $${projectedEomUsd.toFixed(2)} — at current burn rate, above the $${PROJECTED_CRITICAL_USD} target cap.`;
  }

  return {
    mtd_usd: round2(mtdUsd),
    projected_eom_usd: round2(projectedEomUsd),
    today_usd: round2(todayUsd),
    days_elapsed: daysElapsed,
    days_in_month: daysInMonth,
    alert_state: alertState,
    alert_reason: alertReason,
    daily: dailyRows.map((r) => ({
      day: r.day,
      cost_usd: round2(r.cost_usd),
      call_count: r.call_count,
    })),
    per_feature: featureRows.map((r) => ({
      feature: r.feature,
      cost_usd: round2(r.cost_usd),
      call_count: r.call_count,
    })),
    per_model: modelRows.map((r) => ({
      model: r.model,
      cost_usd: round2(r.cost_usd),
      call_count: r.call_count,
    })),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
