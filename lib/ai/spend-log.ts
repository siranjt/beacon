/**
 * META-A5 — Anthropic spend instrumentation.
 *
 * Records one row in `beacon_anthropic_spend_log` per Anthropic API call we
 * make, with token counts + computed USD cost. The /admin/anthropic-spend
 * dashboard reads from this table for month-to-date totals, daily trends,
 * per-feature breakdowns, and burn-rate projections.
 *
 * Plan B (this module) is the primary signal — it's fresh within seconds of
 * a call landing and captures the prompt-caching + cache-read tokens the
 * billing API takes 24h to surface. Phase 2 will also pull Anthropic's
 * usage-report endpoint as a cross-check.
 *
 * ── Contract ────────────────────────────────────────────────────────────
 *   logSpend(...) is FIRE-AND-FORGET. Callers MUST NOT await it. If they do
 *   await, they're paying for a Postgres round-trip on the hot path of every
 *   Anthropic call. Always `void logSpend(...)`.
 *
 *   The function never throws. All errors are swallowed with a warn.
 *
 * ── Pricing ─────────────────────────────────────────────────────────────
 *   Constants are USD per 1M tokens, per the Anthropic pricing page (Sonnet
 *   4.6 / Opus 4.6 / Haiku 4.5). Update these when Anthropic publishes new
 *   tiers. Cache-write tokens cost 1.25× the input rate; cache-read tokens
 *   cost 0.1× the input rate (the canonical prompt-caching discount).
 *
 * ── Slack alert ─────────────────────────────────────────────────────────
 *   When today's running total crosses the daily threshold (default $5),
 *   logSpend posts a Slack alert ONCE per (date, threshold). The dedup
 *   uses `beacon_anthropic_daily_alerts` so concurrent inserts can't
 *   double-fire. Failures here also never throw.
 */

import { getSql } from "@/lib/customer/postgres";
import { postSlack } from "@/lib/customer/slack";

/**
 * USD per 1,000,000 tokens. Source: https://www.anthropic.com/pricing
 *
 * Models we use today:
 *   • Sonnet 4.6  — interactive Beam copilot (ask), shadow verdict, escalation
 *   • Haiku 4.5   — extract, classify, suggest, eval, fact extraction,
 *                   comms perspective, proactive briefings
 *   • Opus 4.6    — rare, only available as a per-request `?model=opus`
 *                   override on post-payment evaluator (no default cost)
 *
 * Cache-read tokens are charged at 0.1× input. Cache-creation tokens cost
 * 1.25× input. These multipliers are applied in priceUsd(), not embedded
 * in the table itself, so updates only need to touch the per-model rows.
 */
export const ANTHROPIC_PRICING_PER_MTOK: Record<
  string,
  { input: number; output: number }
> = {
  // Sonnet 4.6 — $3 / $15 per MTok
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  // Haiku 4.5 — $1 / $5 per MTok
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  // Opus 4.6 — $15 / $75 per MTok
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-opus-4-5": { input: 15.0, output: 75.0 },
};

/** Fallback used when we encounter a model name we don't have pricing for.
 *  Conservative — defaults to Sonnet rate so we OVER-estimate spend on
 *  unknown SKUs rather than under-estimate. */
const FALLBACK_PRICING = { input: 3.0, output: 15.0 };

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Daily spend (in USD) above which we post a single Slack alert per day. */
export const DAILY_SLACK_ALERT_THRESHOLD_USD = 5;

/** Resolve per-model pricing — exposes the fallback path for tests. */
export function pricingFor(model: string): { input: number; output: number } {
  return ANTHROPIC_PRICING_PER_MTOK[model] ?? FALLBACK_PRICING;
}

/**
 * Compute the USD cost of a single Anthropic call from its token usage.
 * Pure function — easy to unit test.
 */
export function priceUsd(args: {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}): number {
  const p = pricingFor(args.model);
  // Per-MTok → per-token: divide by 1e6.
  const inputCost = (args.input_tokens / 1e6) * p.input;
  const outputCost = (args.output_tokens / 1e6) * p.output;
  const cacheReadCost =
    (args.cache_read_tokens / 1e6) * p.input * CACHE_READ_MULTIPLIER;
  const cacheWriteCost =
    (args.cache_creation_tokens / 1e6) * p.input * CACHE_WRITE_MULTIPLIER;
  return (
    Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 1e6) /
    1e6
  );
}

/**
 * Feature labels — keep these stable across redeploys so the dashboard's
 * per-feature breakdown stays comparable over time. Add new ones at the
 * END of the union; downstream code key-matches by string equality.
 */
export type SpendFeature =
  | "ask"
  | "suggest"
  | "evaluator"
  | "extract-notes"
  | "comms-perspective"
  | "facts-extract"
  | "narrative-enrich"
  | "negative-keyword-classify"
  | "negative-keyword-fallback"
  | "shadow-verdict"
  | "post-payment-evaluator"
  | "escalation-agent"
  | "monday-briefing"
  | "daily-digest"
  | "knowledge-upload"
  | "tool-routing"
  | "query-expansion"
  | "draft-email"
  | "draft-slack"
  | "other";

export interface LogSpendInput {
  feature: SpendFeature | string;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  /** Optional scope key — surfaces in the dashboard breakdown. */
  scope?: string | null;
  /** Optional user email — surfaces in the dashboard breakdown. */
  email?: string | null;
}

/**
 * Fire-and-forget insert. NEVER await this. All errors swallowed.
 *
 * After insert, checks if today's running total has crossed the daily
 * threshold and posts a Slack alert (also fire-and-forget, dedupe via
 * `beacon_anthropic_daily_alerts`).
 */
export async function logSpend(input: LogSpendInput): Promise<void> {
  try {
    const sql = getSql();
    if (!sql) return; // POSTGRES_URL unset — local dev, silently skip.

    const inputTok = Math.max(0, input.input_tokens ?? 0);
    const outputTok = Math.max(0, input.output_tokens ?? 0);
    const cacheReadTok = Math.max(0, input.cache_read_tokens ?? 0);
    const cacheWriteTok = Math.max(0, input.cache_creation_tokens ?? 0);

    // Cheap exit: 0 tokens across the board → not worth a DB write. Some
    // call sites (early errors, dry-runs) won't have any usage stats; we
    // just drop them rather than logging $0 rows that inflate counts.
    if (
      inputTok === 0 &&
      outputTok === 0 &&
      cacheReadTok === 0 &&
      cacheWriteTok === 0
    ) {
      return;
    }

    const cost = priceUsd({
      model: input.model,
      input_tokens: inputTok,
      output_tokens: outputTok,
      cache_read_tokens: cacheReadTok,
      cache_creation_tokens: cacheWriteTok,
    });

    await sql`
      INSERT INTO beacon_anthropic_spend_log (
        feature, model,
        input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens,
        cost_usd, scope, email
      ) VALUES (
        ${input.feature}, ${input.model},
        ${inputTok}, ${outputTok},
        ${cacheReadTok}, ${cacheWriteTok},
        ${cost}, ${input.scope ?? null}, ${input.email ?? null}
      )
    `;

    // Daily alert check — fire-and-forget; never blocks the calling code.
    void maybeFireDailyAlert(DAILY_SLACK_ALERT_THRESHOLD_USD);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[anthropic-spend] logSpend failed (non-fatal):",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * If today's running total crosses `thresholdUsd`, post a single Slack alert
 * for the day. Dedup is enforced via the `beacon_anthropic_daily_alerts`
 * primary key — concurrent inserts can race; only the first wins.
 *
 * Safe to call from anywhere; swallows all errors.
 */
async function maybeFireDailyAlert(thresholdUsd: number): Promise<void> {
  try {
    const sql = getSql();
    if (!sql) return;
    if (!process.env.SLACK_WEBHOOK_URL) return;

    // Compute today's running total (UTC date). Cheap aggregate read; no
    // need to filter by feature here — the alert is at the org level.
    const totalsRaw = await sql`
      SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
        FROM beacon_anthropic_spend_log
       WHERE ts >= date_trunc('day', NOW())
    `;
    const totals = totalsRaw as unknown as Array<{ total: number }>;
    const todaySpend = totals[0]?.total ?? 0;
    if (todaySpend < thresholdUsd) return;

    // Atomic dedupe — INSERT ON CONFLICT DO NOTHING returns affected row
    // count via RETURNING; if no row comes back, someone else already
    // fired this alert today.
    const claimRaw = await sql`
      INSERT INTO beacon_anthropic_daily_alerts (alert_date, alert_threshold_usd)
      VALUES (CURRENT_DATE, ${thresholdUsd})
      ON CONFLICT (alert_date, alert_threshold_usd) DO NOTHING
      RETURNING alert_date
    `;
    const claim = claimRaw as unknown as Array<{ alert_date: string }>;
    if (claim.length === 0) return;

    await postSlack({
      text:
        `:fire: *Anthropic daily spend crossed $${thresholdUsd.toFixed(2)}*\n` +
        `Today's running total: *$${todaySpend.toFixed(2)}*\n` +
        `See <${process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : ""}/admin/anthropic-spend|Anthropic spend dashboard>.`,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[anthropic-spend] daily alert check failed (non-fatal):",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Extract token usage from an Anthropic Message response. The SDK's typed
 * `usage` doesn't expose cache fields on every version; we accept `unknown`
 * + access via narrowed cast. Returns 0s on shape drift.
 */
export function extractUsage(maybeMsg: unknown): {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
} {
  if (!maybeMsg || typeof maybeMsg !== "object") {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
  }
  const u = (maybeMsg as { usage?: Record<string, unknown> }).usage ?? {};
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_tokens: num(u.cache_read_input_tokens),
    cache_creation_tokens: num(u.cache_creation_input_tokens),
  };
}
