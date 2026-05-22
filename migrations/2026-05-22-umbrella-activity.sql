-- Phase E-8 — Umbrella-wide activity logging.
--
-- Before this migration, am_activity_log was Customer Beacon-only: every row
-- had role IN (admin/manager/am) and a customer-context surface. We're
-- extending it to capture clicks across all four agents (customer,
-- performance, escalation, post-payment).
--
-- Changes:
--   1. Add `agent` column. Defaults to 'customer' so existing rows are
--      correctly attributed without a backfill.
--   2. Drop NOT NULL from `role`. Any signed-in zoca user can use the other
--      three agents; non-customer-beacon users don't have a role, so the
--      column has to allow NULL going forward.
--   3. Add a composite (agent, ts DESC) index so the digest cron can do
--      per-agent windowed reads efficiently.
--
-- Idempotent: safe to re-run.
--
-- Run on Neon (production POSTGRES_URL):
--   psql "$POSTGRES_URL" -f migrations/2026-05-22-umbrella-activity.sql

BEGIN;

ALTER TABLE am_activity_log
  ADD COLUMN IF NOT EXISTS agent TEXT NOT NULL DEFAULT 'customer';

ALTER TABLE am_activity_log
  ALTER COLUMN role DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_am_activity_log_agent_ts
  ON am_activity_log (agent, ts DESC);

-- Useful for per-user per-agent counts (admin view, future audits).
CREATE INDEX IF NOT EXISTS idx_am_activity_log_email_agent_ts
  ON am_activity_log (email, agent, ts DESC);

COMMIT;

-- Verification (run separately, not part of the BEGIN/COMMIT):
--   SELECT column_name, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'am_activity_log'
--      AND column_name IN ('agent', 'role');
--   -- Expect: agent NO 'customer', role YES NULL
