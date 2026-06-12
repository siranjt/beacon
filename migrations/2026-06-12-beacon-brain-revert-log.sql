-- WAVE-A-2 — Self-service Keeper supersede rollback (audit log).
--
-- Background
-- ----------
-- Wave-2 conflict resolution (lib/brain/ranking.ts + writeBrainFact) leaves
-- the losing fact in the table with superseded_by = winner.fact_id. The data
-- is never deleted — the loser is just hidden from the default read path.
-- Until now, undoing a bad supersede ("the new fact was wrong, please surface
-- the old one again") required a direct DB tap.
--
-- This migration adds the audit table for the new self-service Revert flow:
--   POST /api/admin/keeper/revert  →  revertSupersession(factId, actor)
--
-- A revert is itself a supersede event (the previously-authoritative fact
-- becomes the loser, the previously-superseded fact becomes the winner). The
-- live row's superseded_by columns track the CURRENT chain; this audit table
-- records the WHO + WHEN + WHY of each revert action so we can answer
-- "who flipped this customer's owner_name back on June 12?"
--
-- Backwards compatible: empty on existing dbs, no data churn. Index is on
-- (customer_id, reverted_at DESC) so the Validate inbox + Keeper panel can
-- show "recent reverts on this customer" in chronological order cheaply.

CREATE TABLE IF NOT EXISTS beacon_brain_revert_log (
  id            BIGSERIAL PRIMARY KEY,
  reverted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  customer_id   TEXT NOT NULL,
  -- NOTE: beacon_brain_facts.fact_id is UUID (see 2026-06-04-beacon-brain-wave-1.sql).
  -- The spec text described these as BIGINT — corrected here so the FK shape matches.
  reverted_from_fact_id UUID NOT NULL,
  reverted_to_fact_id   UUID NOT NULL,
  actor_email   TEXT,
  reason        TEXT
);

CREATE INDEX IF NOT EXISTS beacon_brain_revert_log_customer_idx
  ON beacon_brain_revert_log (customer_id, reverted_at DESC);
