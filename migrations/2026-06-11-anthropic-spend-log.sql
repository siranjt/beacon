-- =============================================================================
-- META-A5 — Admin cost observability (/admin/anthropic-spend).
--
-- Plan B: track our OWN Anthropic spend by inserting one row per API call we
-- make. We aggregate from here for the dashboard rather than depending on
-- Anthropic's usage-report endpoint, which has end-of-day lag and would
-- require a separate org-API key. Phase 2 cross-checks against the official
-- usage API are tracked in META-A5 followups.
--
-- All inserts are fire-and-forget from the API call sites — failures NEVER
-- block the caller. Index on (ts DESC) so the dashboard's "last 30 days"
-- scan + the per-day spend alert dedup both stay O(log N).
--
-- `daily_spend_alerts` is the dedup table for the "today's spend exceeded
-- $5" Slack alert. One row per (alert_date, alert_threshold_usd) so a single
-- threshold fires at most once per day.
-- =============================================================================

CREATE TABLE IF NOT EXISTS beacon_anthropic_spend_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 6) NOT NULL,
  scope TEXT NULL,
  email TEXT NULL
);

CREATE INDEX IF NOT EXISTS beacon_anthropic_spend_log_ts_idx
  ON beacon_anthropic_spend_log (ts DESC);

CREATE INDEX IF NOT EXISTS beacon_anthropic_spend_log_feature_ts_idx
  ON beacon_anthropic_spend_log (feature, ts DESC);

CREATE TABLE IF NOT EXISTS beacon_anthropic_daily_alerts (
  alert_date DATE NOT NULL,
  alert_threshold_usd NUMERIC(10, 2) NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (alert_date, alert_threshold_usd)
);
