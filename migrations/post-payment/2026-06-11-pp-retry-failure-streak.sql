-- =============================================================================
-- OPT-8: Post-Payment retry-pending queue cap + per-customer failure streak.
--
-- Adds a `retry_failure_streak` column to the post-payment `customers` table so
-- the hourly retry cron can throttle customers that keep failing (3+ consecutive
-- retries → flipped to `failed`, removed from the retry queue). Pair with the
-- queue-depth-based MAX_PER_RUN cap in the cron route, this prevents a wedged
-- queue of N customers from burning 25 Sonnet evaluator calls per hour silently
-- (~$4/customer/run × 25 = $100/day at the prior steady-state).
--
-- ── IMPORTANT — separate DB ──────────────────────────────────────────────────
-- The post-payment Neon project is wired to POST_PAYMENT_POSTGRES_URL, NOT the
-- umbrella POSTGRES_URL that scripts/migrate.mjs targets. scripts/migrate.mjs
-- will SKIP this file unless POSTGRES_URL temporarily points at the post-payment
-- DB during a manual run, OR a parallel runner pointed at POST_PAYMENT_POSTGRES_URL
-- picks it up.
--
-- For now: run manually against the post-payment DB before the next deploy. See
-- the followup ops debt task to wire a second runner pass.
-- =============================================================================

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS retry_failure_streak INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS customers_retry_failure_streak_idx
  ON customers (retry_failure_streak)
  WHERE status = 'pending_entity';
