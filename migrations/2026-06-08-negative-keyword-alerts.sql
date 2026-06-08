-- Phase NK-1 — Negative Keyword Beacon alerts table.
--
-- One row per detected negative-signal alert. Written by the cron (every 6h)
-- that walks the BaseSheet entity list, fetches each customer's last 14d of
-- comms via the per-entity Metabase URL, pre-screens for negative keywords,
-- and runs Haiku classification on the candidates.
--
-- The dashboard UI reads from this table (NOT from the live CSV feeds).
-- AMs see rows where owning_am_email matches their session email; managers
-- and admins see everything. Orphan rows (no am_name in BaseSheet) get
-- owning_am_email = siranjith.t@zoca.com as a fallback owner.
--
-- Design notes:
--   - Per-entity strict pattern. Cron loops 1,765 BaseSheet entities,
--     parallelized at ~20 concurrent. ~30-60 min per run is fine since the
--     UI reads from the cached table, not from the live cron output.
--   - 14-day window is enforced at write time. Older alerts get garbage-
--     collected by a separate sweep that nukes anything older than 30d
--     where the AM never created a ticket (kept around for retro analysis).
--   - dedup_key follows the doc spec: source + entity_id + first 80 chars of
--     message_body. Video falls back to timestamp (no body). Combined with
--     (source, entity_id) into a unique constraint so re-running the cron
--     never inserts duplicate alerts for the same message.
--   - ticket_* fields are null until an AM clicks "Create ticket" — at
--     which point we hit Linear, get back the issue id + url, and stamp
--     the row. dismissed_* same shape for the "this isn't a real signal"
--     escape hatch.
--   - classifier records which mode wrote the row ('ai' | 'regex-fallback').
--     Lets us measure how often we degrade and track recall on each path.

CREATE TABLE IF NOT EXISTS beacon_negative_keyword_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Customer identification
  entity_id UUID NOT NULL,
  customer_id TEXT,                 -- Chargebee handle, null when unmappable
  business_name TEXT NOT NULL,
  am_name TEXT,                     -- null when orphaned
  owning_am_email TEXT NOT NULL,    -- routed to siranjith.t@zoca.com when am_name is blank

  -- Message metadata
  source TEXT NOT NULL,             -- 'App Chat' | 'Email' | 'SMS' | 'Phone' | 'Video'
  subject TEXT,
  message_body TEXT,
  message_date DATE NOT NULL,
  message_time TIME,
  sender TEXT,

  -- Classification output
  risk_category TEXT NOT NULL,      -- 'Cancellation' | 'Billing' | 'Lead quality' | 'Technical' | 'Disappointed' | 'Flagged'
  analysis TEXT NOT NULL,           -- Haiku 2-sentence output (or heuristic fallback)
  classifier TEXT NOT NULL,         -- 'ai' | 'regex-fallback'

  -- Dedup key — doc spec: source + entity_id + first 80 chars of message_body.
  -- Stored separately from message_body so the unique constraint is fast.
  dedup_key TEXT NOT NULL,

  -- Ticket creation tracking (null until AM clicks "Create ticket")
  ticket_id TEXT,
  ticket_identifier TEXT,           -- Linear's human-readable id like FIN-1234
  ticket_url TEXT,
  ticket_created_at TIMESTAMPTZ,
  ticket_created_by_email TEXT,

  -- AM dismissal — "this isn't a real signal, hide it"
  dismissed_at TIMESTAMPTZ,
  dismissed_by_email TEXT,
  dismissed_reason TEXT,

  -- Lifecycle timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT beacon_negative_keyword_alerts_source_check
    CHECK (source IN ('App Chat', 'Email', 'SMS', 'Phone', 'Video')),
  CONSTRAINT beacon_negative_keyword_alerts_category_check
    CHECK (risk_category IN ('Cancellation', 'Billing', 'Lead quality', 'Technical', 'Disappointed', 'Flagged')),
  CONSTRAINT beacon_negative_keyword_alerts_classifier_check
    CHECK (classifier IN ('ai', 'regex-fallback'))
);

-- Unique per source+entity+dedup_key — cron upserts are idempotent on this.
CREATE UNIQUE INDEX IF NOT EXISTS beacon_negative_keyword_alerts_dedup_idx
  ON beacon_negative_keyword_alerts (source, entity_id, dedup_key);

-- AM-scoped reads: WHERE owning_am_email = $1 ORDER BY message_date DESC, message_time DESC.
CREATE INDEX IF NOT EXISTS beacon_negative_keyword_alerts_am_date_idx
  ON beacon_negative_keyword_alerts (owning_am_email, message_date DESC, message_time DESC);

-- Manager view filter: by category + date range.
CREATE INDEX IF NOT EXISTS beacon_negative_keyword_alerts_category_date_idx
  ON beacon_negative_keyword_alerts (risk_category, message_date DESC);

-- Quick lookup of "has this entity got an open ticket already" — the cron
-- + linear.ts dedup check both need this.
CREATE INDEX IF NOT EXISTS beacon_negative_keyword_alerts_entity_ticket_idx
  ON beacon_negative_keyword_alerts (entity_id, ticket_id);
