-- Phase E-9 Evolving Beacon AI — Phase 2: distilled facts per user.
--
-- Beacon AI already remembers raw conversation turns (beacon_ai_conversations).
-- This table stores the LAYER ABOVE: stable, distilled facts about each user
-- extracted from their conversations. Facts get injected into the system
-- prompt's "USER PROFILE" section so Beacon AI personalizes responses
-- without re-reading the full conversation history every time.
--
-- Two fact sources:
--   1. extracted  — produced by the periodic Haiku extraction cron over
--                   the last 7 days of conversations
--   2. explicit   — user typed "/remember X" in the AskPanel
--
-- Confidence is 0.00-1.00. Explicit facts default to 1.00. Extracted
-- facts default to 0.85; re-extraction increments confidence and refreshes
-- last_seen_at, signaling persistence over time.
--
-- Run on Neon SQL Editor, one statement at a time.

CREATE TABLE IF NOT EXISTS beacon_ai_user_facts (
  id                BIGSERIAL PRIMARY KEY,
  email             TEXT NOT NULL,
  fact              TEXT NOT NULL,
  -- "preference" (style/format), "context" (who/what they care about),
  -- "behavior" (when/how they use Beacon), "explicit" (user told us).
  category          TEXT,
  source            TEXT NOT NULL,        -- extracted | explicit
  confidence        NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reference_count   INT NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT TRUE
);

-- Hot path: load all active facts for a user, ordered by recency
CREATE INDEX IF NOT EXISTS idx_beacon_ai_facts_email_active
  ON beacon_ai_user_facts (email, active, last_seen_at DESC);

-- Dedup path: when extraction wants to re-add the same fact text, we
-- look it up by email + fact and bump last_seen_at instead of inserting.
CREATE INDEX IF NOT EXISTS idx_beacon_ai_facts_email_fact
  ON beacon_ai_user_facts (email, LOWER(fact));

-- Verify (run separately):
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'beacon_ai_user_facts' ORDER BY ordinal_position;
