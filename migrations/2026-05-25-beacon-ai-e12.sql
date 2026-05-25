-- Phase E-12 — Per-Individual Memory Upgrade for Beacon AI.
--
-- Three structural changes:
--   1. Add `scope_key` to beacon_ai_user_facts so style/tone preferences can
--      vary per surface (inbox vs customer-360 vs post-payment). Existing
--      facts have scope_key=NULL (global, applies everywhere).
--   2. Create beacon_ai_feedback table to capture thumbs up/down on every
--      Beacon AI response. Each row links to the conversation turn the user
--      reacted to AND the snapshot of fact IDs that were active when the
--      response was generated — so we can demote/reinforce those facts.
--   3. Add `active_fact_ids` JSONB to beacon_ai_conversations.metadata —
--      done via metadata, no DDL change (existing column is already JSONB).
--
-- Also: the FactCategory enum gains `style`, `tone`, `depth`, `onboarding`
-- values in code. The DB stores category as TEXT so no DDL change needed,
-- just an update to lib/ai/facts.ts.
--
-- Run on Neon SQL Editor, one statement at a time:
--   psql "$POSTGRES_URL" -f migrations/2026-05-25-beacon-ai-e12.sql

-- ---------------------------------------------------------------------------
-- 1) scope_key on facts — surface-aware preferences
-- ---------------------------------------------------------------------------
ALTER TABLE beacon_ai_user_facts
  ADD COLUMN IF NOT EXISTS scope_key TEXT;

-- Lookup path: load all facts that apply at a given surface
-- (scope_key matches current scope OR is NULL = global).
CREATE INDEX IF NOT EXISTS idx_beacon_ai_facts_email_scope
  ON beacon_ai_user_facts (email, scope_key, active, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- 2) beacon_ai_feedback — thumbs up/down per turn
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS beacon_ai_feedback (
  id                BIGSERIAL PRIMARY KEY,
  email             TEXT NOT NULL,
  -- FK to beacon_ai_conversations.id. We don't enforce FK so a delete in the
  -- conversations table doesn't cascade-drop feedback (we want to keep the
  -- learning signal even if the turn itself is pruned).
  turn_id           BIGINT NOT NULL,
  -- "up" reinforces the facts that were active when the assistant generated
  -- this response. "down" demotes them. The set of fact IDs is captured at
  -- response time in beacon_ai_conversations.metadata->>'active_fact_ids'.
  signal            TEXT NOT NULL CHECK (signal IN ('up', 'down')),
  -- Optional free-text reason — captured only if the user fills in the
  -- inline "tell us more" field after thumbs-down.
  reason            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_beacon_ai_feedback_email_ts
  ON beacon_ai_feedback (email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_beacon_ai_feedback_turn
  ON beacon_ai_feedback (turn_id);

-- Idempotency on (turn_id, signal) — we treat a re-click as a no-op rather
-- than letting the user pile on +1 forever. A user can switch from up to
-- down (or vice versa) by deleting + re-inserting, which we'll handle at
-- the application layer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_beacon_ai_feedback_turn_signal
  ON beacon_ai_feedback (turn_id, signal);
