-- Phase SV-1 — Shadow verdict + AM tier feedback tables.
--
-- Shadow run: LLM produces a daily verdict per active customer alongside
-- the existing deterministic composite score. Both are stored; only the
-- deterministic tier is shown to AMs during the shadow window. We measure
-- agreement, drift, and accuracy against lagging signals (escalations,
-- churn, AM follow-up) over 4 weeks before deciding to augment / replace /
-- drop the LLM verdict.
--
-- One row per (run_date, entity_id). Re-running the cron on the same day
-- is idempotent via the unique index.
--
-- Why store raw_llm_response: forensics when verdict looks wrong. Cheap
-- (~2KB JSONB per row), bounded by the 4-week shadow window.

CREATE TABLE IF NOT EXISTS beacon_shadow_verdict (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Run scope
  run_date DATE NOT NULL,
  entity_id UUID NOT NULL,
  am_name TEXT,                                   -- BaseSheet at run time
  am_email TEXT,                                  -- resolved at run time
  bizname TEXT,                                   -- BaseSheet at run time

  -- Deterministic (existing scoring) — snapshot at run time
  deterministic_tier TEXT NOT NULL,               -- 'RED' | 'YELLOW' | 'GREEN'
  deterministic_composite INT NOT NULL,
  deterministic_signal_summary TEXT,              -- short serialized chip list

  -- LLM verdict (new) — what the model produced
  llm_tier TEXT NOT NULL,                         -- 'RED' | 'YELLOW' | 'GREEN'
  llm_confidence INT NOT NULL,                    -- 0..100
  llm_reasoning TEXT NOT NULL,
  llm_primary_driver TEXT NOT NULL,               -- billing | comms | performance | tickets | sentiment | mixed
  llm_retention_window_months INT,
  llm_key_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  llm_disagreement_self_flag BOOLEAN NOT NULL DEFAULT FALSE,

  -- Derived agreement metrics (computed at write time)
  agreement BOOLEAN NOT NULL,                     -- llm_tier == deterministic_tier
  drift_severity INT NOT NULL,                    -- 0 (agree) | 1 (adj tier) | 2 (red↔green skip)

  -- Forensics
  raw_llm_response JSONB,                         -- full Anthropic response for debugging
  haiku_input_tokens INT,
  haiku_output_tokens INT,
  elapsed_ms INT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT beacon_shadow_verdict_det_tier_check
    CHECK (deterministic_tier IN ('RED', 'YELLOW', 'GREEN')),
  CONSTRAINT beacon_shadow_verdict_llm_tier_check
    CHECK (llm_tier IN ('RED', 'YELLOW', 'GREEN')),
  CONSTRAINT beacon_shadow_verdict_drift_check
    CHECK (drift_severity BETWEEN 0 AND 2)
);

-- Idempotent cron: re-running for the same day upserts via this unique key.
CREATE UNIQUE INDEX IF NOT EXISTS beacon_shadow_verdict_day_entity_uq
  ON beacon_shadow_verdict (run_date, entity_id);

-- Admin page reads: filter to today + sort by drift.
CREATE INDEX IF NOT EXISTS beacon_shadow_verdict_run_date_idx
  ON beacon_shadow_verdict (run_date DESC, drift_severity DESC);

-- AM-level scopes: list disagreements for an AM.
CREATE INDEX IF NOT EXISTS beacon_shadow_verdict_am_email_idx
  ON beacon_shadow_verdict (am_email, run_date DESC) WHERE am_email IS NOT NULL;

-- Per-entity time series: did the LLM verdict flip-flop day to day?
CREATE INDEX IF NOT EXISTS beacon_shadow_verdict_entity_idx
  ON beacon_shadow_verdict (entity_id, run_date DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- AM tier feedback — real-time accuracy signal during shadow.
-- AMs click (✓ accurate / ✗ wrong) on the existing stoplight tier shown to
-- them today. Feedback is per (entity, am_email, calendar_day) — re-voting
-- the same day overwrites their last vote.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS beacon_tier_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_date DATE NOT NULL DEFAULT CURRENT_DATE,
  entity_id UUID NOT NULL,
  am_email TEXT NOT NULL,                         -- who clicked
  observed_tier TEXT NOT NULL,                    -- the tier they saw on the card
  is_accurate BOOLEAN NOT NULL,                   -- TRUE = ✓ accurate, FALSE = ✗ wrong
  reason TEXT,                                    -- optional free-text the AM provides
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT beacon_tier_feedback_tier_check
    CHECK (observed_tier IN ('RED', 'YELLOW', 'GREEN'))
);

-- Idempotent per-day vote.
CREATE UNIQUE INDEX IF NOT EXISTS beacon_tier_feedback_day_entity_am_uq
  ON beacon_tier_feedback (feedback_date, entity_id, am_email);

-- Admin page reads.
CREATE INDEX IF NOT EXISTS beacon_tier_feedback_date_idx
  ON beacon_tier_feedback (feedback_date DESC);
