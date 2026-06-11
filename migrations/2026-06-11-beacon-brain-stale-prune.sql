-- SMART-K2 (Auto-prune stale Keeper facts) — schema columns.
--
-- As Keeper accumulates facts across months, retrieval quality suffers
-- from noise: a fact that hasn't been touched in 6+ months AND has never
-- been cited by Beam is almost always stale (org reshuffles, AMs
-- changed, customer pivoted, etc.). We mark them as such, hide from the
-- default read path, but keep them queryable for audit.
--
-- Two columns:
--   - is_stale BOOLEAN — when true, default retrieval skips this fact.
--     Defaults to false (no behavior change for existing rows).
--   - marked_stale_at TIMESTAMPTZ — when the daily prune job last
--     promoted the fact to stale. Kept distinct from updated_at so the
--     ranking score isn't disturbed by the prune sweep.
--
-- Partial index keeps the live read path fast even as the table grows.
-- Mirrors the existing beacon_brain_facts_authoritative_idx shape, plus
-- the is_stale = false filter.

ALTER TABLE beacon_brain_facts
  ADD COLUMN IF NOT EXISTS is_stale BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS marked_stale_at TIMESTAMPTZ NULL;

-- Partial index so default read path (is_stale = false) stays fast even
-- after months of accumulated stale rows. Mirrors the authoritative
-- partial index shape but adds the stale filter.
CREATE INDEX IF NOT EXISTS beacon_brain_facts_live_idx
  ON beacon_brain_facts (customer_id, topic_subcategory)
  WHERE is_stale = false
    AND soft_deleted_at IS NULL
    AND confidence_state = 'confirmed';
