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
  | "concerns";

export type TopicSubcategory =
  // identity
  | "owner_info"
  | "decision_makers"
  | "sold_by"
  // operational
  | "contract"
  | "integration"
  | "feature_usage"
  // behavioral
  | "payment_pattern"
  | "comms_preference"
  | "seasonal"
  | "demo_style"
  // concerns
  | "latent_risk"
  | "next_call_agenda"
  | "soft_red_flag";

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
    ],
  },
  integration: {
    category: "operational",
    named_fields: ["platform", "integration_state", "integration_notes"],
  },
  feature_usage: {
    category: "operational",
    named_fields: [
      "features_active",
      "features_inactive",
      "feature_adoption_notes",
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
    named_fields: ["high_season_months", "low_season_notes", "vacation_dates"],
  },
  demo_style: {
    category: "behavioral",
    named_fields: ["demo_engagement", "follow_up_pattern"],
  },
  // concerns
  latent_risk: {
    category: "concerns",
    named_fields: ["risk_description", "risk_severity", "watch_until"],
  },
  next_call_agenda: {
    category: "concerns",
    named_fields: ["agenda_item", "raised_by", "raised_at"],
  },
  soft_red_flag: {
    category: "concerns",
    named_fields: ["flag_description", "flag_category"],
  },
};

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
