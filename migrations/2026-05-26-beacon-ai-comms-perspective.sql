-- Phase E-18 — Haiku Comms Perspective layer.
--
-- One row per (entity, snapshot_date) holding the structured perspective
-- produced by Haiku over a 90-day comms feed (chat + email + phone +
-- video + sms). Surfaces sentiment / topics / substance / initiator
-- pattern / response latency / conversation arcs / 2-3 sentence summary.
--
-- Caching contract:
--   - One row per (entity_id, snapshot_date). Repeated calls within the
--     same day hit the cache; force-refresh upserts.
--   - The on-demand /api endpoint is the only path that triggers Haiku.
--     The bulk dashboard pass reads cache only and never recomputes.
--
-- See lib/customer/comms-perspective-store.ts for the read/write API.

CREATE TABLE IF NOT EXISTS beacon_ai_comms_perspective (
  entity_id              uuid NOT NULL,
  snapshot_date          date NOT NULL,
  message_count          int  NOT NULL,
  channel_mix            jsonb NOT NULL,
  direction_mix          jsonb NOT NULL,
  sentiment              text NOT NULL,
  sentiment_evidence     jsonb NOT NULL,
  topics                 text[] NOT NULL,
  substance_score        int  NOT NULL CHECK (substance_score BETWEEN 0 AND 100),
  initiator_pattern      text NOT NULL,
  response_latency_hours numeric,
  conversation_arcs      jsonb NOT NULL,
  haiku_summary          text NOT NULL,
  computed_at            timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_beacon_ai_comms_perspective_entity
  ON beacon_ai_comms_perspective(entity_id);

CREATE INDEX IF NOT EXISTS idx_beacon_ai_comms_perspective_recent
  ON beacon_ai_comms_perspective(computed_at DESC);
