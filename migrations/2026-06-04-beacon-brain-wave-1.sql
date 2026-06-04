-- Beacon Brain — Wave 1 schema.
--
-- Per-customer canonical-truth store. Every fact about a customer
-- (identity, operational, behavioral, concerns) lives here as a typed
-- row keyed on (customer_id, field_name), independently versioned and
-- approved. Consumed by Beacon AI at retrieval time.
--
-- Design decisions captured in conversation 2026-06-04 (see brainstorm
-- log for full rationale):
--   - Per-customer_id scoping (multi-location businesses share one Brain).
--   - Two-level taxonomy: topic_category + topic_subcategory.
--   - Structured field_name per row (~45 named fields + unlimited 'other').
--   - confidence_state: 'candidate' until an AM confirms, then 'confirmed'.
--   - Only confirmed facts reach Beacon AI's prompt.
--   - source_type tracks origin so the Validate inbox can show provenance.
--   - sunset_at nullable on every row (some fields expire, some don't).
--   - Soft-delete via soft_deleted_at; rows stay queryable via version log.
--   - Beacon AI only at v1 — customer-facing agents do NOT read this.
--
-- Migration-runner note (see [[beacon-migration-runner-limits]] memory):
--   Splits on ';' at line end. No PL/pgSQL DO blocks here; uses GENERATED
--   columns and explicit constraints only.

CREATE TABLE IF NOT EXISTS beacon_brain_facts (
  fact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Chargebee customer handle. One Brain per customer; multi-location
  -- businesses share. NOT the entity_id (the BaseSheet/snapshot key).
  customer_id TEXT NOT NULL,

  -- Top-level category from the 4-bucket taxonomy:
  --   'identity' | 'operational' | 'behavioral' | 'concerns'
  topic_category TEXT NOT NULL,

  -- Subcategory from the 12-bucket strawman:
  --   identity:    'owner_info' | 'decision_makers' | 'sold_by'
  --   operational: 'contract' | 'integration' | 'feature_usage'
  --   behavioral:  'payment_pattern' | 'comms_preference' | 'seasonal' | 'demo_style'
  --   concerns:    'latent_risk' | 'next_call_agenda' | 'soft_red_flag'
  topic_subcategory TEXT NOT NULL,

  -- Field within the subcategory. Named fields (e.g. 'owner_name',
  -- 'contract_renewal_at', 'preferred_channel') OR 'other' for the
  -- catchall. Named fields are unique per (customer_id, field_name);
  -- 'other' rows are unlimited per (customer_id, subcategory).
  field_name TEXT NOT NULL,

  -- The fact's value. Free-form text; the field_name dictates the
  -- expected shape (date string, comma-separated list, etc.).
  -- Application layer enforces field-type semantics.
  value TEXT NOT NULL,

  -- 'candidate' (Haiku-extracted or AM-submitted-not-yet-confirmed) or
  -- 'confirmed' (Validate inbox approved, or auto-confirmed from a
  -- trusted source at bootstrap, or written by an AM via the
  -- per-line save gesture or add_fact_to_brain conversational tool).
  -- Only 'confirmed' rows reach Beacon AI's retrieval.
  confidence_state TEXT NOT NULL CHECK (confidence_state IN ('candidate','confirmed')),

  -- Provenance for the Validate inbox source pill:
  --   'basesheet' | 'chargebee' | 'customer_note' |
  --   'beacon_ai_conversation' | 'beacon_ai_extracted' | 'manual'
  source_type TEXT NOT NULL,

  -- Optional reference back to the source row (note_id, invoice_id,
  -- conversation turn_id, etc.) — used in the Validate card popover.
  source_ref TEXT,

  -- The AM responsible for this customer at the time the fact was
  -- written. Default = customer's assigned AM at write time; persists
  -- across AM transitions for audit (we don't rewrite history).
  owning_am_email TEXT,

  -- Audit trail for the confirm action. NULL while the fact is a
  -- candidate; set when an AM (or manager override) flips it to
  -- 'confirmed'.
  confirmed_by_email TEXT,
  confirmed_at TIMESTAMPTZ,

  -- Expiry. NULL = evergreen. Past sunset_at → the fact is no longer
  -- surfaced in retrieval but stays queryable in the version log.
  -- AMs are prompted to set this on Concerns/* and Behavioral/seasonal
  -- subcategories where expiry is the norm.
  sunset_at TIMESTAMPTZ,

  -- Optimistic concurrency + version log key. Incremented by the
  -- writer on each material change. Version 1 is the row's first
  -- value; the version log holds prior versions.
  current_version INT NOT NULL DEFAULT 1,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Soft-delete. NULL = active. Set when an AM rejects / explicitly
  -- deletes via the Brain panel. The version log preserves the
  -- pre-delete state.
  soft_deleted_at TIMESTAMPTZ
);

-- Most common retrieval pattern: pull all confirmed non-deleted facts
-- for one customer. Index covers the WHERE; the topic_category in the
-- key lets the planner cluster the result on disk.
CREATE INDEX IF NOT EXISTS beacon_brain_facts_customer_topic_idx
  ON beacon_brain_facts (customer_id, topic_category)
  WHERE soft_deleted_at IS NULL;

-- Validate inbox: candidates by AM email (AM view) or all candidates
-- (manager view). Partial-index keeps it tight.
CREATE INDEX IF NOT EXISTS beacon_brain_facts_candidates_idx
  ON beacon_brain_facts (owning_am_email, created_at DESC)
  WHERE confidence_state = 'candidate' AND soft_deleted_at IS NULL;

-- Sunset sweep: nightly cron will look for rows past their sunset_at
-- to auto-archive (move to soft-deleted state with a sunset reason).
CREATE INDEX IF NOT EXISTS beacon_brain_facts_sunset_idx
  ON beacon_brain_facts (sunset_at)
  WHERE sunset_at IS NOT NULL AND soft_deleted_at IS NULL;

-- Field-name uniqueness for NAMED fields only. 'other' rows are
-- explicitly excluded so AMs can stack multiple long-tail facts per
-- subcategory.
CREATE UNIQUE INDEX IF NOT EXISTS beacon_brain_facts_unique_field_idx
  ON beacon_brain_facts (customer_id, topic_subcategory, field_name)
  WHERE field_name != 'other' AND soft_deleted_at IS NULL;

-- Manager cross-book search (q_brain tool will hit this):
--   "show all customers whose payment_pattern says 'turned off'"
-- Doesn't need full-text; LIKE / ILIKE on the value column works at
-- our scale (~10K total fact rows). Add tsvector later if needed.
CREATE INDEX IF NOT EXISTS beacon_brain_facts_field_value_idx
  ON beacon_brain_facts (topic_subcategory, field_name)
  WHERE confidence_state = 'confirmed' AND soft_deleted_at IS NULL;


-- ─────────────────────────────────────────────────────────────────────
-- Version log: append-only history of every material change.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS beacon_brain_fact_versions (
  id BIGSERIAL PRIMARY KEY,

  -- Denormalized for query speed; matches the fact row at write time.
  customer_id TEXT NOT NULL,
  fact_id UUID NOT NULL,

  -- Version number, matches the value of beacon_brain_facts.current_version
  -- at the moment this row was written.
  version INT NOT NULL,

  -- Snapshot of the fact's content at this version.
  value TEXT NOT NULL,
  confidence_state TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT,

  -- For UI diff rendering — what the value was BEFORE this version.
  -- NULL on the initial v1 row.
  prior_value TEXT,

  -- Audit trail. The actor (AM email or 'system' for cron-driven sunset
  -- archives) and the reason for this change.
  changed_by_email TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Allowed values:
  --   'create' | 'confirm' | 'refine' | 'edit' | 'reject' |
  --   'conflict_resolved' | 'restored' | 'sunset' | 'soft_delete'
  change_reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS beacon_brain_fact_versions_fact_idx
  ON beacon_brain_fact_versions (fact_id, version DESC);

CREATE INDEX IF NOT EXISTS beacon_brain_fact_versions_customer_idx
  ON beacon_brain_fact_versions (customer_id, changed_at DESC);


-- ─────────────────────────────────────────────────────────────────────
-- Conflict queue: surfaces semantic disagreements between a new
-- proposed value and the confirmed value. Filled by the conflict-check
-- Haiku call at write time; resolved one-click from the Validate inbox.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS beacon_brain_conflicts (
  id BIGSERIAL PRIMARY KEY,

  customer_id TEXT NOT NULL,

  -- The existing confirmed fact this conflict is about.
  fact_id UUID NOT NULL,

  -- The new value that disagreed with the confirmed one.
  proposed_value TEXT NOT NULL,
  proposed_source_type TEXT NOT NULL,
  proposed_source_ref TEXT,
  proposed_by_email TEXT,

  -- Haiku's verdict from the conflict-check call:
  --   'differ' (real conflict) | 'uncertain' (could go either way —
  --   treated as conflict for safety)
  haiku_verdict TEXT NOT NULL CHECK (haiku_verdict IN ('differ','uncertain')),
  -- Haiku's brief explanation, shown on the resolution card.
  haiku_reasoning TEXT,

  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Resolution.
  -- 'replace' = keep proposed_value as the new confirmed value
  -- 'keep_existing' = drop proposed_value, keep current confirmed
  -- 'keep_both' = current stays; proposed becomes a separate 'other' row
  -- 'cancel' = no action, user dismissed the conflict
  resolution TEXT CHECK (resolution IN ('replace','keep_existing','keep_both','cancel')),
  resolved_by_email TEXT,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS beacon_brain_conflicts_unresolved_idx
  ON beacon_brain_conflicts (customer_id, detected_at DESC)
  WHERE resolution IS NULL;

CREATE INDEX IF NOT EXISTS beacon_brain_conflicts_fact_idx
  ON beacon_brain_conflicts (fact_id);
