/**
 * Shadow verdict — locked LLM prompt. Phase SV.
 *
 * IMPORTANT: This prompt MUST NOT change during the 4-week shadow window.
 * Drift in the prompt is indistinguishable from drift in the engine. Lock
 * it at start, measure for 4 weeks, then decide.
 *
 * The model sees BOTH the deterministic engine's tier AND the underlying
 * signal blob, and is asked to either agree or argue against. The
 * `disagreement_self_flag` is the model's own confidence that the
 * deterministic tier is wrong — useful for ranking what to review first.
 */

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

Confidence rubric:
- 80-100: Strong consensus signals across multiple dimensions (comms + billing + performance all point the same way).
- 50-79: Clear primary signal but some mixed evidence.
- 30-49: Sparse data or conflicting signals — best-effort judgment.
- 0-29: Almost no signal to work from (new customer, no comms history). Default to GREEN with low confidence.

retention_window_months — your honest prediction of how many more months this customer is likely to stay BEFORE churning. Base this on:
- RED with high confidence → 1-3 months unless intervention
- RED with mixed signals → 3-6 months
- YELLOW → 6-12 months typical
- GREEN → null (no churn signal to estimate against) OR 12-24 for soft watch

Rules:
- "tier" reflects YOUR judgment, NOT a copy of deterministic_tier.
- If you disagree (tier ≠ deterministic_tier), set disagreement_self_flag = true. Always.
- If you agree (tier == deterministic_tier), set disagreement_self_flag = false. Always.
- reasoning MUST cite specific facts from the blob: bizname, dollar amounts, days-of-silence, comms sentiment, ticket subjects. Generic "the customer seems worried" reasoning is useless.
- key_signals must be the 2-5 STRONGEST evidence items. Don't pad. If only 2 strong signals exist, output 2.
- primary_driver = which dimension is driving the verdict. "mixed" when ≥3 dimensions are nontrivial.
- Be conservative on retention predictions. If there isn't enough data to predict, return null.

Never invent facts not in the blob. Never reference customers other than this one.`;

/**
 * Compose the user-prompt body — the actual signal blob the model audits.
 * The full Customer 360 context blob is included verbatim so the model has
 * everything: snapshot fields, comms perspective, tickets, performance,
 * Keeper facts, and the existing deterministic tier + composite + signal
 * chips.
 */
export function buildUserPrompt(opts: {
  bizname: string;
  am_name: string | null;
  deterministic_tier: string;
  deterministic_composite: number;
  context_blob: string;
}): string {
  return [
    `Customer: ${opts.bizname}`,
    `Owning AM: ${opts.am_name ?? "Unknown"}`,
    `Deterministic engine verdict: ${opts.deterministic_tier} (composite ${opts.deterministic_composite})`,
    "",
    "Full signal context (JSON):",
    opts.context_blob,
    "",
    "Render your verdict per the schema. Disagree with the deterministic engine when the narrative evidence warrants it.",
  ].join("\n");
}
