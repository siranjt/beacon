-- Phase E-19 Wave 1 — comms_events table.
--
-- The canonical operational cache for customer communications. Stage B's
-- comms phase fetches the bulk-events Metabase question (one SQL pass over
-- the union of chat/email/phone/sms/video tables) and upserts the result
-- here. UI surfaces (customer cards, rollups, AskPanel context, Customer 360
-- timeline) read from this table — never from Metabase on the hot path.
--
-- The per-entity Metabase question stays available for deep drill-downs
-- where freshness matters more than latency (the 360 page's full message
-- timeline, the on-demand Haiku perspective refresh).
--
-- Design notes:
--   - No message_body. Bodies stay in Metabase. We re-fetch them on demand
--     in the drill-down path. Keeps this table small and PII-light.
--   - Idempotent upsert key is (entity_id, channel, source_id). The bulk
--     SQL guarantees a non-null source_id after its ROW_NUMBER dedup, so
--     re-running an ingest with overlapping windows is safe.
--   - Index strategy:
--       PK             — covers UPSERT ON CONFLICT
--       (entity, ts↓)  — covers the dominant per-customer timeline read
--       (ts↓)          — covers cross-customer "events in last N days"
--                        analytics (anomaly digest, rollup freshness, etc.)
--       (entity, ch)   — covers per-channel filters on the timeline
--   - ingested_at is the watermark for "how fresh is this entity's comms
--     cache" — UI freshness banner reads MAX(ingested_at) per entity.
--   - entity_id is uuid to match the convention used elsewhere in Beacon
--     (beacon_ai_comms_perspective, customer_snapshots, etc.).

CREATE TABLE IF NOT EXISTS comms_events (
  entity_id      uuid        NOT NULL,
  channel        text        NOT NULL CHECK (channel IN ('chat','email','phone','sms','video')),
  source_id      text        NOT NULL,
  direction      text        NOT NULL CHECK (direction IN ('inbound','outbound','system')),
  subtype        text,
  sender_name    text,
  body_available boolean     NOT NULL DEFAULT FALSE,
  created_at     timestamptz NOT NULL,
  ingested_at    timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_id, channel, source_id)
);

CREATE INDEX IF NOT EXISTS idx_comms_events_entity_created
  ON comms_events (entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comms_events_recent
  ON comms_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comms_events_entity_channel
  ON comms_events (entity_id, channel);

-- Watermark table — per-entity record of the latest ingestion run. Lets us
-- answer "how stale is this customer's comms cache" without scanning events,
-- and powers the freshness banner on customer cards.
CREATE TABLE IF NOT EXISTS comms_events_watermark (
  entity_id        uuid        PRIMARY KEY,
  last_ingested_at timestamptz NOT NULL DEFAULT NOW(),
  last_event_at    timestamptz,
  event_count_90d  int         NOT NULL DEFAULT 0
);
