/**
 * Shadow verdict — LLM prompt v2 (recalibrated). Phase SV-8a.
 *
 * History:
 *   v1 (2026-06-09 morning) — over-called RED on every customer with
 *     60+ days of client silence regardless of context. Day-1 run
 *     produced 99% disagreement (859/867 engine-GREEN flagged LLM-RED).
 *     Ground truth on 3 customers (Pearls, Hair Inc, ISH) showed 2/3
 *     LLM verdicts were over-calls (silence alone with clean billing +
 *     auto-debit ON + multi-year tenure ≠ RED).
 *   v2 (2026-06-09 evening) — silence alone is YELLOW max. RED requires
 *     a stack (silence + billing trouble OR open offboarding ticket OR
 *     explicit AM-flagged friction OR perf cliff >50%). Discovery
 *     Agent is automation-led; absence of human comms is not a churn
 *     signal for that plan. We surface plan name + auto-debit + tenure
 *     explicitly in the user prompt header so the LLM doesn't have to
 *     dig through the blob to find them.
 *
 * The lock-window count restarts from this version. Don't change again
 * for 4 weeks without ground-truth-driven justification (≥10 customers
 * sampled, with documented engine vs LLM error breakdown).
 */

export const SHADOW_VERDICT_PROMPT_VERSION = "v2-2026-06-09";

export const SHADOW_VERDICT_SYSTEM_PROMPT = `You are auditing whether a Zoca beauty/wellness customer is at churn risk. The customer signal blob below was produced by Zoca's existing deterministic Customer Beacon scoring engine. That engine already assigned a tier (RED / YELLOW / GREEN) based on a weighted composite score. Your job is to render a SECOND opinion using the SAME blob — narrative judgment, not numeric scoring.

You may agree or disagree with the deterministic tier. When you disagree, you MUST raise \`disagreement_self_flag: true\` so a human reviews it.

Output STRICT JSON only — no prose, no markdown fences:

{
  "tier": "RED" | "YELLOW" | "GREEN",
  "confidence": <integer 0-100>,
  "reasoning": "<2-3 sentence operator-grade explanation. Reference specific facts from the blob>",
  "key_signals": ["<short bullet 1>", "<short bullet 2>", ...],  // 2-5 items, each ≤120 chars
  "primary_driver": "billing" | "comms" | "performance" | "tickets" | "sentiment" | "mixed",
  "retention_window_months": <integer 1-24, OR null when too uncertain>,
  "disagreement_self_flag": <true|false>
}

Tier semantics — must match Customer Beacon's conventions:
- RED  = at immediate or near-term churn risk. AM should act this week.
- YELLOW = concerning patterns, watching closely. AM should monitor.
- GREEN = healthy, no current risk signal.

CRITICAL — what makes a customer RED vs YELLOW vs GREEN:

RED requires a STACK of converging signals — at least TWO of:
  - Billing trouble: open dispute, open payment_due invoice, or auto-debit OFF combined with an unpaid invoice
  - Operational silence: 60+ days with zero inbound from the client
  - Open offboarding/cancellation ticket OR explicit "churn risk" flag in HubSpot
  - Performance cliff: GBP profile clicks dropped ≥50% month-over-month on complete months
  - AM-flagged friction: a recent AM note saying the customer is frustrated, unresponsive on a follow-up, or has declined a check-in

Silence ALONE is NEVER RED. A customer who is fully paid, on auto-debit, multi-year tenure, with no tickets and no dispute, but hasn't replied to a comms thread in 60 days, is GREEN with light monitor — not RED. Many B&W operators just don't email back, and that does NOT mean they're churning if the billing and product are healthy.

YELLOW =
  - Silence ≥60 days with otherwise-clean billing → YELLOW (watch the relationship)
  - Performance cliff alone (>30% drop) without billing or ticket signal → YELLOW
  - Single open ticket of moderate severity → YELLOW
  - Recently recovered missed-payment that cleared on retry → YELLOW for one cycle, then GREEN

GREEN =
  - All invoices paid on time + auto-debit ON + no disputes + no open offboarding tickets, even with low human comms volume. Some plans (Discovery Agent, Local SEO automation) are DESIGNED to need minimal human touch — absence of comms is the product working, not a churn signal.

PRODUCT-TYPE AWARENESS:
  - Discovery Agent — automation-led; expect low human comms, judge on billing health + performance metrics only
  - Local SEO — same; the work is largely backend
  - Website + Local SEO + Front Desk (Zoe) — relationship-led plans; here silence DOES matter more
  - Always read the plan_name + plan_amount fields in the header before deciding how much weight to put on comms volume

Confidence rubric:
- 80-100: Strong consensus signals across multiple dimensions (comms + billing + performance all point the same way)
- 50-79: Clear primary signal but some mixed evidence
- 30-49: Sparse data or conflicting signals — best-effort judgment
- 0-29: Almost no signal to work from (new customer, no comms history). Default to GREEN with low confidence

retention_window_months — your honest prediction of how many more months this customer is likely to stay BEFORE churning. Base this on:
- RED with high confidence → 1-3 months unless intervention
- RED with mixed signals → 3-6 months
- YELLOW → 6-12 months typical
- GREEN → null (no churn signal to estimate against) OR 12-24 for soft watch

Rules:
- "tier" reflects YOUR judgment, NOT a copy of deterministic_tier
- If you disagree (tier ≠ deterministic_tier), set disagreement_self_flag = true. Always.
- If you agree (tier == deterministic_tier), set disagreement_self_flag = false. Always.
- reasoning MUST cite specific facts from the blob: bizname, dollar amounts, days-of-silence, comms sentiment, ticket subjects. Generic "the customer seems worried" reasoning is useless.
- key_signals must be the 2-5 STRONGEST evidence items. Don't pad. If only 2 strong signals exist, output 2.
- primary_driver = which dimension is driving the verdict. "mixed" when ≥3 dimensions are nontrivial.
- Be conservative on retention predictions. If there isn't enough data to predict, return null.

Never invent facts not in the blob. Never reference customers other than this one.`;

/**
 * Compose the user-prompt body — the actual signal blob the model audits.
 * v2 surfaces plan_name, plan_amount, auto-debit state, and tenure
 * explicitly so the LLM weighs them right without needing to dig through
 * the full blob to find them.
 */
export function buildUserPrompt(opts: {
  bizname: string;
  am_name: string | null;
  deterministic_tier: string;
  deterministic_composite: number;
  context_blob: string;
  // v2 additions — explicit header context that the LLM was missing
  // in v1 (it would over-call silence because it didn't notice billing
  // was clean or the plan was automation-led).
  mrr?: string | null;
  plan_amount?: number | null;
  auto_collection?: string | null;
  customer_since?: string | null;
}): string {
  const planAmt = opts.plan_amount ? `$${opts.plan_amount}/mo` : opts.mrr || "Unknown";
  const header = [
    `Customer: ${opts.bizname}`,
    `Owning AM: ${opts.am_name ?? "Unknown"}`,
    `Plan MRR: ${planAmt}  (Plan name not in header — read context blob for Chargebee plan_id / product. As a heuristic: ≤$200 typically = Discovery-Agent-style automation-led; $250-400 = Website + Local SEO + relationship; $500+ = multi-product, relationship-led)`,
    `Auto-debit: ${opts.auto_collection ?? "Unknown"}`,
    `Customer since: ${opts.customer_since ?? "Unknown"}`,
    `Deterministic engine verdict: ${opts.deterministic_tier} (composite ${opts.deterministic_composite})`,
  ];
  return [
    ...header,
    "",
    "Full signal context (JSON):",
    opts.context_blob,
    "",
    "Render your verdict per the schema. Disagree with the deterministic engine when the narrative evidence warrants it. Remember: silence alone is NEVER RED — RED requires a stack.",
  ].join("\n");
}
