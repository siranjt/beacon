-- Phase E-17.3c — Beacon AI eval harness.
--
-- Two tables:
--   beacon_ai_eval_pairs  — curated golden Q&A pairs. One per question.
--   beacon_ai_eval_runs   — historical results, one row per (pair, run).
--
-- The nightly cron iterates active pairs, hits the AI endpoint, judges
-- the response with Haiku-as-judge, and stores the verdict. A regression
-- alert fires to Slack when the rolling pass rate drops materially.

CREATE TABLE IF NOT EXISTS beacon_ai_eval_pairs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Scope discriminator: matches AiScope.kind in lib/ai/scopes.ts
  scope_kind           text NOT NULL CHECK (scope_kind IN (
    'inbox','customer-360','customer-book',
    'performance-landing','performance-report',
    'escalation-overview','post-payment-book','post-payment-customer'
  )),
  -- Scope params (entity_id, cb_customer_id) for scoped pairs. null for
  -- whole-book scopes. Stored as jsonb for flexibility.
  scope_params         jsonb,
  -- The question we ask Beacon AI as if a manager/AM typed it
  question             text NOT NULL,
  -- Facts that MUST appear in the answer to count as a pass. Free-text;
  -- the Haiku judge checks semantic coverage (not regex).
  expected_facts       jsonb NOT NULL,
  -- Strings the answer must NOT contain (confabulation guards, escalation
  -- of resolved issues, etc). Optional.
  expected_anti_facts  jsonb,
  -- Optional human notes about why this pair exists / what it tests
  rationale            text,
  active               boolean NOT NULL DEFAULT TRUE,
  created_at           timestamptz NOT NULL DEFAULT NOW(),
  updated_at           timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_beacon_ai_eval_pairs_active
  ON beacon_ai_eval_pairs (active, scope_kind);

CREATE TABLE IF NOT EXISTS beacon_ai_eval_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_id              uuid NOT NULL REFERENCES beacon_ai_eval_pairs(id) ON DELETE CASCADE,
  ran_at               timestamptz NOT NULL DEFAULT NOW(),
  -- The AI's actual answer (truncated to 4000 chars for storage hygiene)
  ai_response          text NOT NULL,
  ai_response_ms       int NOT NULL,
  -- Judge output
  judge_verdict        text NOT NULL CHECK (judge_verdict IN ('pass','partial','fail','error')),
  judge_reasoning      text,
  facts_covered        jsonb,    -- array of expected_facts that WERE covered
  facts_missed         jsonb,    -- array that were MISSED
  anti_facts_triggered jsonb,    -- array of expected_anti_facts that DID appear (bad)
  passed               boolean NOT NULL    -- denormalized for quick aggregates
);

CREATE INDEX IF NOT EXISTS idx_beacon_ai_eval_runs_pair_ran
  ON beacon_ai_eval_runs (pair_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_beacon_ai_eval_runs_ran
  ON beacon_ai_eval_runs (ran_at DESC);
