-- Wave-2 (Beam/Keeper conflict resolution + ranking) — schema columns.
--
-- When two facts on the same (customer_id, topic_subcategory, field_name)
-- cluster semantically conflict (similarity >= 0.92 detected by Wave 2b),
-- today the second write throws unless force_semantic_conflict=true. With
-- force=true both rows land — but Beam has no way to know which one to
-- cite, so the older (or worse-sourced) fact may end up in the prompt.
--
-- Wave-2 adds two columns:
--   - superseded_by UUID — when set, this fact is NOT authoritative.
--     Beam's read path filters to superseded_by IS NULL by default.
--     Points at the winning fact_id in the same cluster. NULL = authority.
--   - ranking_score NUMERIC — the deterministic score
--     (recency × confidence × source_trust) used to pick the winner.
--     Persisted so the Validate inbox + admin tools can show the math.
--
-- Resolution flow (in lib/brain/ranking.ts + writeBrainFact):
--   1. Conflict detected (sim >= 0.92) and force=true
--   2. Insert the new fact
--   3. Find the cluster — new fact + neighbor + any rows already chained
--      via superseded_by pointing into the neighbor
--   4. Compute ranking_score for every member
--   5. Highest-score row keeps superseded_by=NULL (authoritative)
--   6. Other rows get superseded_by=<winner.fact_id>
--
-- Backwards compatible: every existing row has superseded_by=NULL =>
-- still authoritative. No backfill required. ranking_score stays NULL
-- on existing rows until they participate in a conflict.

ALTER TABLE beacon_brain_facts
  ADD COLUMN IF NOT EXISTS superseded_by UUID NULL
    REFERENCES beacon_brain_facts(fact_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ranking_score NUMERIC NULL;

-- Partial index for the hot read path: "give me the authoritative fact
-- at (customer, subcategory, field)". Filtered by superseded_by IS NULL
-- to keep the index small (only authoritative rows; superseded rows
-- become rare and are read only for audit).
CREATE INDEX IF NOT EXISTS beacon_brain_facts_authoritative_idx
  ON beacon_brain_facts (customer_id, topic_subcategory, field_name)
  WHERE superseded_by IS NULL
    AND soft_deleted_at IS NULL
    AND confidence_state = 'confirmed';

-- Reverse-lookup index: "show me all rows superseded by X". Used by
-- the Validate inbox audit view + admin tools to render the cluster
-- history. Sparse — most rows have superseded_by NULL.
CREATE INDEX IF NOT EXISTS beacon_brain_facts_superseded_by_idx
  ON beacon_brain_facts (superseded_by)
  WHERE superseded_by IS NOT NULL;
