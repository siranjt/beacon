/**
 * Beacon Brain — Wave 1 types.
 *
 * The Brain stores per-customer canonical facts. Each fact is one row
 * keyed on (customer_id, topic_subcategory, field_name) — see
 * migrations/2026-06-04-beacon-brain-wave-1.sql for the schema.
 *
 * Design rationale (see brainstorm log 2026-06-04):
 *   - Two-level taxonomy: TopicCategory + TopicSubcategory.
 *   - Structured fields per subcategory (~45 named fields total).
 *   - 'other' is the catchall field_name allowing unlimited rows per
 *     subcategory for facts that don't fit the schema.
 *   - confidence_state gates retrieval: only 'confirmed' reaches Beacon AI.
 *   - source_type tracks provenance for the Validate inbox source pill.
 *   - sunset_at allows time-bound facts (concerns / seasonal) to auto-archive.
 */

export type TopicCategory =
  | "identity"
  | "operational"
  | "behavioral"
  | "concerns"
  // Wave 1.1 — relationship is a NEW top-level category for advocacy
  // + engagement facts. Conceptually distinct from behavioral (which
  // is day-to-day patterns); relationship captures the strategic arc
  // between Zoca and the customer.
  | "relationship";

export type TopicSubcategory =
  // identity
  | "owner_info"
  | "decision_makers"
  | "sold_by"
  // Wave 1.1 — AM ownership + transition history. Includes 4 DERIVED
  // fields (current_am, current_ae, current_pod, current_sp) that
  // are synthesized from snapshot at retrieval time, NOT stored in
  // beacon_brain_facts. See DERIVED_ASSIGNMENT_FIELDS below.
  | "assignment"
  // Wave 1.1 — the actual shape of the business (services, staff,
  // locations, ownership structure).
  | "business_profile"
  // operational
  | "contract"
  | "integration"
  | "feature_usage"
  // Wave 1.1 — broader customer tech ecosystem (GBP, website, POS,
  // social) distinct from operational/integration which holds the
  // Zoca-side booking integration.
  | "tech_stack"
  // Wave 1.1 — forward-looking renewal narrative (advocates, pull/push
  // factors, retention strategy). Contract dates stay in contract;
  // this holds the story.
  | "renewal"
  // Wave 1.1 — onboarding + first-value history. CS handoff story.
  | "onboarding"
  // Wave 1.1 — performance context narrative (why are the snapshot
  // signals like they are). Sits alongside the raw numbers from the
  // Performance Beacon.
  | "performance_context"
  // behavioral
  | "payment_pattern"
  | "comms_preference"
  | "seasonal"
  | "demo_style"
  // Wave 1.1 — competitive / switching context. Where did they come
  // from, what could pull them away.
  | "competitive_context"
  // Wave 1.2 — rebook cadence. How often does this customer's end-clients
  // rebook (the structural rhythm of their book). Sits alongside seasonal,
  // which is about external timing pressure.
  | "cadence"
  // Wave 1.2 — sentiment / NPS-equivalent signals. Latest "would they
  // recommend us" read, lightweight and timestamped. Distinct from
  // relationship/advocacy (which holds the strategic advocacy posture).
  | "sentiment"
  // concerns
  | "latent_risk"
  | "next_call_agenda"
  | "soft_red_flag"
  // Wave 1.1 — relationship category subcategories
  | "advocacy"
  | "engagement";

/**
 * Source taxonomy — the Validate inbox renders these as colored pills,
 * each conveying how much auto-trust the source warrants.
 *
 *   basesheet              → high-trust, auto-confirm at bootstrap
 *   chargebee              → high-trust, auto-confirm at bootstrap
 *   customer_note          → AM-written, lands as candidate
 *   beacon_ai_conversation → AM said it via add_fact_to_brain tool
 *   beacon_ai_extracted    → Haiku extraction (must validate before use)
 *   manual                 → AM typed directly in the Brain panel
 */
export type FactSourceType =
  | "basesheet"
  | "chargebee"
  | "customer_note"
  | "beacon_ai_conversation"
  | "beacon_ai_extracted"
  | "manual";

export type ConfidenceState = "candidate" | "confirmed";

export type ChangeReason =
  | "create"
  | "confirm"
  | "refine"
  | "edit"
  | "reject"
  | "conflict_resolved"
  | "restored"
  | "sunset"
  | "soft_delete";

export type ConflictVerdict = "differ" | "uncertain";

export type ConflictResolution =
  | "replace"
  | "keep_existing"
  | "keep_both"
  | "cancel";

/** Live fact row — matches beacon_brain_facts shape. */
export interface BrainFact {
  fact_id: string;
  customer_id: string;
  topic_category: TopicCategory;
  topic_subcategory: TopicSubcategory;
  field_name: string;
  value: string;
  /**
   * Wave 1.1 — parsed integer for numeric-shaped fields (staff_count,
   * location_count). Populated by writeBrainFact when field_name is in
   * NUMERIC_FIELDS; NULL for everything else. Enables manager queries
   * like "staff_count >= 5" via searchFacts.
   */
  value_numeric: number | null;
  confidence_state: ConfidenceState;
  source_type: FactSourceType;
  source_ref: string | null;
  owning_am_email: string | null;
  confirmed_by_email: string | null;
  confirmed_at: string | null;
  sunset_at: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
  soft_deleted_at: string | null;
  /**
   * Wave 2b — pgvector(1024) embedding from Voyage voyage-3-lite over
   * `${topic_subcategory} / ${field_name}: ${value}`. NULL until backfill
   * runs or until VOYAGE_API_KEY is set. Not surfaced to clients — used
   * server-side for semantic-conflict gate + (Wave 2b.2) top-K retrieval.
   *
   * Typed as `number[] | null` in TS even though Postgres returns it as
   * a string literal "[0.1, 0.2, ...]" via the Neon driver. Consumers
   * should not access this field directly; query through the helper.
   */
  embedding?: number[] | string | null;
  /**
   * SMART-K1 — AM-feedback citation counter. Bumped (fire-and-forget) every
   * time the fact is presented to Beam through the hybrid retrieval path
   * (read_customer_brain or query_brain). Drives amFeedbackBoost() in
   * ranking.ts so frequently-cited facts surface earlier on future
   * retrievals. Backwards-compat: defaults to 0 on existing rows → boost
   * 1.0 → no change to ranking until citations accumulate.
   */
  citation_count: number;
  /**
   * SMART-K1 — wall-clock of the most recent citation bump. NULL when the
   * fact has never been presented. Currently used for diagnostics + future
   * "decay stale citations" sweeps; not factored into amFeedbackBoost yet.
   */
  last_cited_at: string | null;
  /**
   * SMART-K2 — when true, this fact is hidden from default retrieval but
   * preserved on the row for audit. Set by the daily stale-prune cron
   * (lib/brain/stale-prune.ts) when a fact has gone untouched for 6+
   * months AND has zero citations. Defaults to false; existing rows stay
   * live until the next prune sweep judges them.
   */
  is_stale?: boolean;
  /**
   * SMART-K2 — wall-clock when is_stale was flipped to true. NULL on live
   * rows. Kept distinct from updated_at so the prune sweep doesn't drag
   * every fact's recency score down on every nightly run.
   */
  marked_stale_at?: string | null;
  /**
   * SMART-K4 — parent fact this row is derived from (same customer scope).
   * Lets retrieveFactsHybrid auto-pull the parent when a derived child
   * lands in the top-K, so Beam sees both rows side-by-side and never
   * cites a child fact without the parent context.
   *
   * NULL on every existing row (backwards compatible). Set explicitly by
   * AMs via the add_fact_to_brain tool when classifying a fact that's
   * derived from another (e.g. owner_email derived from owner_info,
   * preferred_channel derived from comms_preference).
   *
   * Cross-customer references are rejected at writeBrainFact validation
   * time. The DB-level FK only enforces fact_id global uniqueness; the
   * same-customer invariant lives in application code.
   */
  derived_from?: string | null;
}

/** Version log row — append-only history. */
export interface BrainFactVersion {
  id: number;
  customer_id: string;
  fact_id: string;
  version: number;
  value: string;
  confidence_state: ConfidenceState;
  source_type: FactSourceType;
  source_ref: string | null;
  prior_value: string | null;
  changed_by_email: string;
  changed_at: string;
  change_reason: ChangeReason;
}

/** Conflict queue row. */
export interface BrainConflict {
  id: number;
  customer_id: string;
  fact_id: string;
  proposed_value: string;
  proposed_source_type: FactSourceType;
  proposed_source_ref: string | null;
  proposed_by_email: string | null;
  haiku_verdict: ConflictVerdict;
  haiku_reasoning: string | null;
  detected_at: string;
  resolution: ConflictResolution | null;
  resolved_by_email: string | null;
  resolved_at: string | null;
}

/**
 * Input shape for writing a new fact. Server fills fact_id, current_version,
 * timestamps; callers provide content + provenance + (optionally) the
 * approval-time fields if auto-confirming at bootstrap.
 */
export interface BrainFactWrite {
  customer_id: string;
  topic_category: TopicCategory;
  topic_subcategory: TopicSubcategory;
  field_name: string;
  value: string;
  source_type: FactSourceType;
  source_ref?: string | null;
  owning_am_email?: string | null;
  /**
   * When provided + non-null, the fact is written as 'confirmed' with
   * confirmed_by_email + confirmed_at set. Used for high-trust sources
   * (basesheet/chargebee) that bootstrap as confirmed.
   * When null/undefined, the fact lands as 'candidate' awaiting AM approval.
   */
  confirmed_by_email?: string | null;
  sunset_at?: string | null;
  /**
   * Wave 2b — when true, skip the semantic-conflict gate (cosine
   * similarity check against existing same-customer facts). Used by
   * the `force` path in add_fact_to_brain so AMs can override a
   * flagged near-duplicate when they actually meant to write one.
   *
   * Default false: writes that semantically collide throw
   * SemanticConflictError.
   */
  force_semantic_conflict?: boolean;
  /**
   * SMART-K4 — parent fact this row is derived from. Must point at a
   * fact_id under the SAME customer_id; writeBrainFact rejects cross-
   * customer references. Optional / nullable for backwards compatibility
   * (most facts have no parent).
   */
  derived_from?: string | null;
}

/**
 * Strawman field catalog. Named fields per subcategory — anything not
 * in this catalog has to use 'other' as the field_name.
 *
 * The catalog is referenced by:
 *   - Haiku extraction prompts (which field names to propose).
 *   - The Brain panel UI (which fields to show as labeled rows).
 *   - The Validate inbox (which field label to render on the card).
 *   - Add_fact_to_brain auto-suggest (which subcategory + field this
 *     content best fits).
 */
export const FIELD_CATALOG: Record<
  TopicSubcategory,
  { category: TopicCategory; named_fields: readonly string[] }
> = {
  // identity
  owner_info: {
    category: "identity",
    named_fields: [
      "owner_name",
      "owner_nickname",
      "owner_role",
      "decision_style",
    ],
  },
  decision_makers: {
    category: "identity",
    named_fields: ["secondary_contacts", "manager_relationships"],
  },
  sold_by: {
    category: "identity",
    named_fields: [
      "sold_by_ae",
      "sold_at",
      "sales_promise",
      "time_to_first_value",
      // Wave 2c.4 (v3) — specific commitments made at sale that CS/AM now
      // has to deliver. Distinct from sales_promise (which is the headline
      // pitch); this is the granular "AE said X" that becomes a churn risk
      // if not honored. Promoted from 'other' (heaviest pattern observed).
      "ae_commitment",
    ],
  },
  // Wave 1.1 — AM ownership + transition history. The 4 DERIVED fields
  // (current_am, current_ae, current_pod, current_sp) are listed in
  // DERIVED_ASSIGNMENT_FIELDS below and are NOT in named_fields here
  // because add_fact_to_brain shouldn't accept them — they come from
  // snapshot, auto-synced.
  assignment: {
    category: "identity",
    named_fields: [
      "transition_history",
      "last_transition_at",
      "transition_reason",
      "customer_relationship_context",
      // Wave 2c.4 (v3) — last AM before the current one. Distinct from
      // transition_history (free-form narrative chain); this is the
      // single most-recent prior AM name for quick lookups. Common
      // pattern in 'other' when AMs document handoffs.
      "prior_am",
    ],
  },
  // Wave 1.1 — the actual shape of the business.
  business_profile: {
    category: "identity",
    named_fields: [
      "service_focus",
      "service_mix",
      "location_count",
      "staff_count",
      "business_age",
      "ownership_structure",
      "business_model_note",
      "aesthetic_market_segment",
      // Wave 2c.4 (v3) — specific service specialty the shop is known
      // for (e.g. "balayage", "color correction", "box braids"). Distinct
      // from service_focus (broad category) — this is the differentiator
      // that drives the customer's local SEO + word-of-mouth pull.
      "service_specialty",
    ],
  },
  // operational
  contract: {
    category: "operational",
    named_fields: [
      "contract_terms",
      "custom_pricing",
      "contract_start",
      "contract_renewal_at",
      "mrr_amount",
      // Wave 2c.4 (v3) — categorical pricing posture. Common values:
      // "standard" / "promotional" / "grandfathered" / "discounted".
      // Lets renewal conversations differentiate "we honored their
      // launch deal" from "they're paying full freight".
      "pricing_tier",
    ],
  },
  integration: {
    category: "operational",
    named_fields: [
      "platform",
      "integration_state",
      "integration_notes",
      // Wave 2c.4 (v3) — chain of prior booking platforms before Zoca
      // (e.g. "Square → GlossGenius → Zoca"). Common 'other' pattern when
      // AMs document migration history during onboarding diagnostics.
      "migration_history",
    ],
  },
  feature_usage: {
    category: "operational",
    named_fields: [
      "features_active",
      "features_inactive",
      "feature_adoption_notes",
    ],
  },
  // Wave 1.1 — broader customer tech ecosystem.
  tech_stack: {
    category: "operational",
    named_fields: [
      "gbp_url",
      "website_url",
      "booking_url",
      "review_platforms",
      "pos_system",
      "social_handles",
      "email_marketing_tool",
    ],
  },
  // Wave 1.1 — forward-looking renewal narrative.
  renewal: {
    category: "operational",
    named_fields: [
      "renewal_advocates",
      "renewal_pull_factors",
      "renewal_push_factors",
      "renewal_risk_level",
      "retention_strategy",
      "pricing_sensitivity_notes",
      "renewal_decision_makers",
    ],
  },
  // Wave 1.1 — onboarding + first-value history.
  onboarding: {
    category: "operational",
    named_fields: [
      "onboarded_by_csm",
      "onboarding_completed_at",
      "time_to_first_lead",
      "first_value_event",
      "onboarding_friction_points",
    ],
  },
  // Wave 1.1 — performance context narrative.
  performance_context: {
    category: "operational",
    named_fields: [
      "gbp_setup_quality",
      "review_velocity_pattern",
      "seasonal_dependency_strength",
      "known_growth_levers",
    ],
  },
  // behavioral
  payment_pattern: {
    category: "behavioral",
    named_fields: [
      "payment_timing",
      "payment_method_preference",
      "auto_debit_history",
    ],
  },
  comms_preference: {
    category: "behavioral",
    named_fields: [
      "preferred_channel",
      "channel_avoid",
      "response_pattern",
      "best_time_to_reach",
    ],
  },
  seasonal: {
    category: "behavioral",
    named_fields: [
      "high_season_months",
      "low_season_notes",
      "vacation_dates",
      // Wave 2c.4 (v3) — explicit slow-months list (e.g.
      // "January, August"). Distinct from low_season_notes (free-form
      // narrative); this is the discrete list for filtering and
      // scheduling-aware AI suggestions.
      "slow_months",
    ],
  },
  demo_style: {
    category: "behavioral",
    named_fields: ["demo_engagement", "follow_up_pattern"],
  },
  // Wave 1.1 — competitive / switching context.
  competitive_context: {
    category: "behavioral",
    named_fields: [
      "prior_platforms",
      "competing_offers_seen",
      "why_chose_zoca",
      "switch_risks",
      "churn_attempt_history",
    ],
  },
  // Wave 1.2 — rebook cadence. rebook_window_weeks is numeric-shaped
  // (see NUMERIC_FIELDS) so manager queries can do "rebook_window_weeks <= 6".
  // last_rebook_at is date-shaped text (YYYY-MM-DD).
  cadence: {
    category: "behavioral",
    named_fields: ["rebook_window_weeks", "last_rebook_at"],
  },
  // Wave 1.2 — NPS-equivalent sentiment. Lightweight timestamped read on
  // "would they recommend us". signal_substance captures the qualitative
  // evidence (e.g. an AM-call quote) behind the categorical signal.
  sentiment: {
    category: "behavioral",
    named_fields: [
      "nps_equivalent_signal",
      "last_signal_at",
      "signal_substance",
    ],
  },
  // concerns
  latent_risk: {
    category: "concerns",
    named_fields: [
      "risk_description",
      "risk_severity",
      "watch_until",
      // Wave 2c.4 (v3) — classification of the risk axis. Common values:
      // "billing" / "delivery" / "perception" / "relationship". Surfaces
      // for filterable risk dashboards (e.g. "all billing risks open").
      "risk_category",
      // Wave 2c.4 (v3) — date-shaped (YYYY-MM-DD). When the risk was
      // resolved or stepped down. Lets AMs distinguish closed-out risks
      // from active ones without soft-deleting the fact.
      "mitigated_at",
    ],
  },
  next_call_agenda: {
    category: "concerns",
    named_fields: ["agenda_item", "raised_by", "raised_at"],
  },
  soft_red_flag: {
    category: "concerns",
    named_fields: ["flag_description", "flag_category"],
  },
  // Wave 1.1 — NEW relationship category.
  advocacy: {
    category: "relationship",
    named_fields: [
      "nps_score",
      "would_refer_likelihood",
      "has_referred",
      "case_study_eligible",
      "public_quote_eligible",
    ],
  },
  engagement: {
    category: "relationship",
    named_fields: [
      "meeting_cadence",
      "last_in_person_meeting",
      "community_events_attended",
    ],
  },
};

/**
 * Derived fields for identity/assignment — synthesized from the snapshot
 * at retrieval time, NOT stored in beacon_brain_facts. The Brain panel
 * + prompt block surface these alongside the curated facts, but
 * writeBrainFact rejects them (they aren't in FIELD_CATALOG.named_fields).
 *
 * Updates to these fields happen automatically when the snapshot
 * refreshes. The version log only tracks AM-curated facts; derived
 * fields don't have history (they're always the snapshot's current view).
 */
export const DERIVED_ASSIGNMENT_FIELDS = [
  "current_am",
  "current_ae",
  "current_pod",
  "current_sp",
] as const;
export type DerivedAssignmentField = (typeof DERIVED_ASSIGNMENT_FIELDS)[number];

/**
 * Numeric-shaped fields. When writeBrainFact writes to one of these,
 * it parses the leading integer from `value` and stores it in
 * `value_numeric` so manager queries can do `staff_count > 5` via
 * searchFacts. Other fields leave value_numeric NULL.
 *
 * If a user types "Variable, 5-8 stylists" we extract 5; the original
 * text stays in `value` for human reading. Beacon AI can quote either.
 */
export const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  "staff_count",
  "location_count",
  // Wave 1.2 — behavioral/cadence. Values like "6", "8", "12" weeks. Manager
  // queries: "rebook_window_weeks <= 6" → high-frequency rebookers.
  "rebook_window_weeks",
]);

/** Parse the leading integer from free text. Returns null if no integer found. */
export function parseLeadingInteger(value: string): number | null {
  if (!value) return null;
  const match = /^\s*(\d+)/.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** Returns the TopicCategory for a given subcategory — derived from the catalog. */
export function categoryForSubcategory(
  sub: TopicSubcategory,
): TopicCategory {
  return FIELD_CATALOG[sub].category;
}

/**
 * Returns true if the field_name is a named (schema-defined) field for
 * the given subcategory. Returns false for 'other' or for any field not
 * in the catalog.
 *
 * Used by the unique constraint application-layer enforcement and by the
 * Brain panel to decide whether to render the field as a labeled row or
 * as a free-form 'other' entry.
 */
export function isNamedField(
  sub: TopicSubcategory,
  field_name: string,
): boolean {
  if (field_name === "other") return false;
  return FIELD_CATALOG[sub].named_fields.includes(field_name);
}
