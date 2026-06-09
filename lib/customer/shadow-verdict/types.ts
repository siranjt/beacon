/**
 * Shadow verdict — shared types. Phase SV.
 *
 * The shadow run produces ONE row per active customer per day. Two
 * verdicts coexist on each row: the existing deterministic composite-
 * derived tier (what AMs see today), and the LLM's tier (hidden during
 * the 4-week shadow). We compare them daily to inform the augment /
 * hybrid / replace / drop decision at week 4.
 */

export type Tier = "RED" | "YELLOW" | "GREEN";

export type PrimaryDriver =
  | "billing"
  | "comms"
  | "performance"
  | "tickets"
  | "sentiment"
  | "mixed";

/** What the LLM is asked to return. Strict JSON contract. */
export interface LlmVerdict {
  tier: Tier;
  confidence: number; // 0..100
  reasoning: string; // 2-3 sentence operator-grade explanation
  key_signals: string[]; // 2-5 short bullets
  primary_driver: PrimaryDriver;
  retention_window_months: number | null; // null when too uncertain
  disagreement_self_flag: boolean; // LLM's own "I think deterministic is wrong"
}

/** Full row written to beacon_shadow_verdict. */
export interface ShadowVerdictRow {
  id: string | null;
  run_date: string; // YYYY-MM-DD
  entity_id: string;
  am_name: string | null;
  am_email: string | null;
  bizname: string | null;

  deterministic_tier: Tier;
  deterministic_composite: number;
  deterministic_signal_summary: string | null;

  llm_tier: Tier;
  llm_confidence: number;
  llm_reasoning: string;
  llm_primary_driver: PrimaryDriver;
  llm_retention_window_months: number | null;
  llm_key_signals: string[];
  llm_disagreement_self_flag: boolean;

  agreement: boolean;
  drift_severity: 0 | 1 | 2;

  raw_llm_response: unknown | null;
  haiku_input_tokens: number | null;
  haiku_output_tokens: number | null;
  elapsed_ms: number | null;

  created_at: string;
}

/** Tier-feedback row written when an AM clicks ✓ accurate / ✗ wrong. */
export interface TierFeedbackRow {
  id: string | null;
  feedback_date: string; // YYYY-MM-DD
  entity_id: string;
  am_email: string;
  observed_tier: Tier;
  is_accurate: boolean;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Tier-difference severity. Used for sorting the admin "disagreements"
 * table — RED↔GREEN skips matter more than YELLOW vs RED adjacency.
 */
export function driftSeverity(a: Tier, b: Tier): 0 | 1 | 2 {
  if (a === b) return 0;
  const ord: Record<Tier, number> = { RED: 0, YELLOW: 1, GREEN: 2 };
  const distance = Math.abs(ord[a] - ord[b]);
  if (distance === 1) return 1;
  return 2;
}

export const TIERS: readonly Tier[] = ["RED", "YELLOW", "GREEN"] as const;
export const PRIMARY_DRIVERS: readonly PrimaryDriver[] = [
  "billing",
  "comms",
  "performance",
  "tickets",
  "sentiment",
  "mixed",
] as const;
