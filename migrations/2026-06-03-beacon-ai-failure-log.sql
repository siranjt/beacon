-- Phase F-polish-AI Tier 3 — Beacon AI failure inbox.
--
-- Beacon AI tags its own "I can't fully answer that" responses with
-- inline `<gap: category — terse description>` markers. The ask route
-- parses those markers out of the final assistant turn and logs one row
-- per gap to beacon_ai_failure_log.
--
-- After two weeks of logging, an admin can mine the table and see the
-- top-ranked classes of failure — most will cluster into 3-5 missing
-- context fields or 1-2 missing tools that we can close in one pass.
-- That ranks the Tier 4 (and beyond) work objectively instead of by
-- guess.
--
-- Categories
--   data_missing       — context blob doesn't have the slice the model needed
--   tool_insufficient  — a tool is available but can't compute the requested shape
--   out_of_scope       — question is outside Beacon AI's role
--   assumption_unclear — ambiguous question, model needed clarification
--
-- Resolution columns let an admin mark a row as closed once a Tier
-- 4/5/etc patch lands — we keep the original row for historical trend
-- analysis (did the rate of `data_missing` actually drop?).
--
-- Migration-runner note: no $-blocks needed here, plain DDL only.

CREATE TABLE IF NOT EXISTS beacon_ai_failure_log (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The Beacon AI scope the user was in when the gap fired. Mirrors
  -- AiScope.kind in lib/ai/scopes.ts.
  scope TEXT NOT NULL CHECK (scope IN (
    'inbox','customer-360','customer-book',
    'performance-landing','performance-report',
    'escalation-overview','post-payment-book','post-payment-customer',
    'miss-payment-overview'
  )),

  -- Scope params (entity_id, cb_customer_id, am_filter, etc.). Null for
  -- whole-book scopes.
  scope_meta JSONB,

  -- Who hit the gap.
  user_email TEXT NOT NULL,
  user_role TEXT CHECK (user_role IN ('admin', 'manager', 'am') OR user_role IS NULL),

  -- The user's actual question — full text. Indexed via GIN trigram for
  -- "find me similar gap reports" later.
  question TEXT NOT NULL,

  -- Tag emitted by the model.
  category TEXT NOT NULL CHECK (category IN (
    'data_missing', 'tool_insufficient', 'out_of_scope', 'assumption_unclear'
  )),

  -- Terse description the model wrote after the em-dash in the marker.
  -- This is what admins triage on.
  description TEXT NOT NULL,

  -- Full assistant response (truncated to 4000 chars for storage hygiene)
  -- so admins can see HOW the model handled the gap, not just that it
  -- happened. Useful when triaging "is this a real product gap or a
  -- prompt drift?"
  full_response TEXT,

  -- Optional link back to the conversation row.
  conversation_id BIGINT,

  -- Resolution audit. Nullable until an admin marks it closed.
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolution_note TEXT
);

-- Sort newest-first for the admin inbox.
CREATE INDEX IF NOT EXISTS beacon_ai_failure_log_occurred_at_idx
  ON beacon_ai_failure_log (occurred_at DESC);

-- Filter by scope (admins triage one surface at a time).
CREATE INDEX IF NOT EXISTS beacon_ai_failure_log_scope_idx
  ON beacon_ai_failure_log (scope);

-- Rollup by category (the "top failure modes" view).
CREATE INDEX IF NOT EXISTS beacon_ai_failure_log_category_idx
  ON beacon_ai_failure_log (category);

-- Partial index for unresolved rows — the inbox is usually filtered
-- to "not yet handled", and this keeps that query off the full table.
CREATE INDEX IF NOT EXISTS beacon_ai_failure_log_unresolved_idx
  ON beacon_ai_failure_log (occurred_at DESC)
  WHERE resolved_at IS NULL;
