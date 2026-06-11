/**
 * Phase 11 — Haiku narrative enrichment.
 *
 * Replaces the deterministic reason_one_line + suggested_action on RED-tier
 * customers with LLM-written variants. Falls back silently to the original
 * template strings on any failure (timeout, JSON parse, missing API key).
 *
 * Concurrency: cap 15. Per-call timeout: 5s (set in callHaikuJson).
 * Total compose-time budget at 922 customers with ~100 REDs:
 *   100 calls / 15 concurrent ≈ 7 batches × 2-3s = ~15-25s.
 * Comfortably within the 90s composeSnapshot maxDuration.
 *
 * Cost: ~$0.001 per call × 100 RED × daily = ~$3/month.
 *
 * NOTE (OPT-7): caller (composeSnapshot in refresh.ts) now gates this to a
 * single run per UTC day instead of every hourly compose tick. Before that
 * gate landed, the hourly cron meant 24× the cost (~$70/month). If you wire
 * a new caller for this function, mind the gate or re-implement equivalent
 * idempotency — Haiku is cheap but not free.
 */

import type { SnapshotV2, ScoredCustomerV2 } from "./types";
import { callHaikuJson, llmConfigured } from "./llm";

const CONCURRENCY = 15;

const SYSTEM_PROMPT = `You are a customer success analyst writing concise per-customer rationales for an account manager dashboard.

INPUT: a JSON object describing one customer's signal scores (0-100), comms recency, performance flags, Chargebee subscription status (cb_status), and the deterministic template that's currently shown.

OUTPUT: strict JSON only — no preamble, no code fences:
{
  "reason": "<<one specific sentence, <= 18 words, naming the dominant signal driving RED status>>",
  "action": "<<one specific time-bound next-best-action, <= 14 words, imperative>>"
}

RULES:
- Be specific. Use numbers when given (days, percentages, counts).
- Action must be a verb-first imperative ("Call today", "Check GBP audit", "Send invoice reminder").
- Don't invent data not in the input. Don't list multiple signals — pick the dominant one.
- Never recommend "monitor", "check in soon", or other vague hedges.
- If template is already concrete, you may keep or sharpen it. If template is generic, rewrite.

VARIETY REQUIREMENTS:
- Never start narratives with the same word twice in the same batch.
- Rotate sentence openers: "Cold-reach...", "Get on the phone...", "Outreach overdue...",
  "Escalation needed...", "Loop in...", "Re-engage via...", "Last touchpoint was...".
- Match the verb to the urgency: critical -> "must / immediately", high -> "today",
  medium -> "this week", watch -> "monitor".
- Vary the closing: some narratives end with the risk ("critical churn risk"),
  some with the action ("before deal closes"), some with context ("last paid 90d ago").

CB_STATUS -> ACTION VERB MAPPING (use the verb that matches the customer's lifecycle):
- cb_status = "active"        -> use "outreach"   (renewal-risk save)
- cb_status = "non_renewing"  -> use "save call"  (last-chance to retain)
- cb_status = "in_trial"      -> use "activation push" (trial conversion)
- cb_status = "future"        -> use "onboarding" (kick off the relationship)
- any other status            -> use "outreach" as a safe default`;

type EnrichedNarrative = { reason: string; action: string };

async function enrichOne(c: ScoredCustomerV2): Promise<void> {
  const s = c.signals_v2;
  const m = c.metrics;
  const fallback: EnrichedNarrative = {
    reason: s.reason_one_line,
    action: s.suggested_action,
  };

  // Build a compact input payload. Keep it small — Haiku reads it cleanly.
  const input = {
    company: c.company || c.entity_id.slice(0, 8),
    pod: c.pod,
    am: c.am_name,
    plan_per_month: c.plan_amount || 0,
    cb_status: c.cb_status || "active",
    stoplight: s.stoplight,
    composite: s.composite,
    signals: {
      we_silent: s.sig_we_silent,
      client_silent: s.sig_client_silent,
      response_drop: s.sig_response_drop,
      volume_collapse: s.sig_volume_collapse,
      usage: s.sig_usage,
      billing: s.sig_billing,
    },
    days_since_we_touched_them:
      m?.days_since_out == null || m.days_since_out >= 9999
        ? "no prior outreach on record"
        : m.days_since_out,
    days_since_they_responded:
      m?.days_since_in == null || m.days_since_in >= 9999
        ? "never replied"
        : m.days_since_in,
    flags: {
      performance: s.flag_performance,
      tickets: s.flag_tickets,
    },
    billing_detail: c.billing
      ? {
          unpaid_count: c.billing.unpaid_invoice_count,
          amount_due: Math.round((c.billing.total_amount_due_cents || 0) / 100),
          oldest_overdue_days: c.billing.days_past_oldest_unpaid,
          auto_collection_off: c.billing.auto_debit_off_with_failures,
          recent_failed_transactions: c.billing.recent_failed_transaction_count,
        }
      : null,
    template: {
      reason: s.reason_one_line,
      action: s.suggested_action,
    },
  };

  const prompt = `Rewrite the rationale + action for this customer. Be specific and concise.\n\n${JSON.stringify(input, null, 2)}`;

  const result = await callHaikuJson<EnrichedNarrative>(
    {
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: 180,
      temperature: 0.2,
      timeoutMs: 5_000,
    },
    fallback,
  );

  // Defensive: only replace if both fields are non-empty strings of reasonable length
  if (
    typeof result.reason === "string" &&
    typeof result.action === "string" &&
    result.reason.trim().length > 0 &&
    result.reason.trim().length <= 240 &&
    result.action.trim().length > 0 &&
    result.action.trim().length <= 180
  ) {
    s.reason_one_line = result.reason.trim();
    s.suggested_action = result.action.trim();
  }
  // else: silently keep the template fallback (already in s)
}

/**
 * Mutate the snapshot in place: enrich narratives for every RED customer.
 * No-op when ANTHROPIC_API_KEY is unset.
 */
export async function enrichRedNarratives(snap: SnapshotV2): Promise<{
  enriched: number;
  skipped: number;
  durationMs: number;
}> {
  const started = Date.now();
  if (!llmConfigured()) {
    return { enriched: 0, skipped: snap.customers.length, durationMs: 0 };
  }

  // Only RED + not pre-launch (pre-launch customers have benign narratives)
  const candidates = snap.customers.filter(
    (c) => (["CRITICAL - DEAL BREAKER", "CRITICAL", "AT-RISK"].includes(String(((c as any).metabase_health?.health_tier) || ""))) && !c.signals_v2.pre_launch,
  );

  if (!candidates.length) {
    return { enriched: 0, skipped: 0, durationMs: Date.now() - started };
  }

  // Concurrency-capped batched runner
  let enriched = 0;
  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const i = idx++;
      try {
        await enrichOne(candidates[i]);
        enriched += 1;
      } catch {
        /* enrichOne always falls back; this catch is belt-and-suspenders */
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker());
  await Promise.all(workers);

  return {
    enriched,
    skipped: snap.customers.length - candidates.length,
    durationMs: Date.now() - started,
  };
}
