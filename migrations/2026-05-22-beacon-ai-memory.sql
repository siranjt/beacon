-- Phase E-9 — Beacon AI copilot memory.
--
-- Persists every user ↔ Beacon turn across all scopes so the copilot
-- has continuity across sessions, devices, and surfaces. Beacon picks
-- up recent cross-scope conversations on every new question and weaves
-- them into the system prompt, giving the impression of an evolving
-- assistant that remembers you.
--
-- This is NOT model fine-tuning. Model weights stay frozen at the
-- Anthropic API. What evolves is the system around the model: an ever-
-- growing context library, scoped per user.
--
-- Run on Neon (production POSTGRES_URL):
--   psql "$POSTGRES_URL" -f migrations/2026-05-22-beacon-ai-memory.sql
-- Or paste into the Neon Console SQL Editor (disengagement-pg project).

BEGIN;

CREATE TABLE IF NOT EXISTS beacon_ai_conversations (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  -- Scope where the turn was uttered. Examples: "inbox", "customer-360:{entity_id}",
  -- "post-payment-customer:{cb_customer_id}", "escalation-overview".
  scope_key    TEXT NOT NULL,
  -- "user" — what the human asked. "assistant" — what Beacon replied.
  role         TEXT NOT NULL,
  -- The literal message content. Capped at 8000 chars on write (truncated
  -- defensively in lib/ai/memory.ts to keep prompts manageable).
  content      TEXT NOT NULL,
  -- Per-turn metadata: model used, token counts, response latency, etc.
  -- Optional — keep small.
  metadata     JSONB,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup paths:
--   1. "What did this user discuss with me lately?" (cross-scope timeline)
--   2. "What did we discuss in this scope?" (current-surface continuity)
-- Both are descending on ts so LIMIT N pulls the most recent.
CREATE INDEX IF NOT EXISTS idx_beacon_ai_conv_email_ts
  ON beacon_ai_conversations (email, ts DESC);

CREATE INDEX IF NOT EXISTS idx_beacon_ai_conv_email_scope_ts
  ON beacon_ai_conversations (email, scope_key, ts DESC);

COMMIT;

-- Verification:
--   SELECT table_name FROM information_schema.tables WHERE table_name = 'beacon_ai_conversations';
--   SELECT indexname FROM pg_indexes WHERE tablename = 'beacon_ai_conversations';
