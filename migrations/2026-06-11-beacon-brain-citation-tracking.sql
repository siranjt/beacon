-- SMART-K1 — AM-feedback signal into Keeper fact ranking.
--
-- Wave-2 ranking shipped a deterministic score:
--   ranking_score = recency × confidence × source_trust
--
-- The next intelligence layer treats AM citation activity as a feedback
-- loop. When Beam answers a question, the facts it surfaces (via the
-- read_customer_brain + query_brain hybrid path) are "presented to the
-- model" — a realistic proxy for "the AM saw this fact cited in an
-- answer". The more often a fact gets presented over time, the more
-- valuable it is empirically — boost its ranking score so it surfaces
-- faster on future retrievals.
--
-- Two columns:
--   - citation_count INT   — monotonic counter, bumped per presentation
--   - last_cited_at  TIMESTAMPTZ — wall-clock of most recent bump
--
-- Backwards compatible: existing rows default to citation_count=0 and
-- last_cited_at=NULL. With count=0, amFeedbackBoost = 1.0 → no change
-- from current ranking. The boost compounds only as citations accumulate.
--
-- NOTE: migration runner can't parse $$ ... $$ blocks (see project memory),
-- so this stays plain ALTER + CREATE INDEX, no triggers, no PL/pgSQL.

ALTER TABLE beacon_brain_facts
  ADD COLUMN IF NOT EXISTS citation_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_cited_at TIMESTAMPTZ NULL;

-- Hot path: ranking re-scoring queries that want to find heavily-cited
-- authoritative confirmed facts (live, not soft-deleted). Sorted by
-- citation_count DESC, last_cited_at DESC so admin dashboards + future
-- re-rank batches can read the top-cited facts directly off the index.
CREATE INDEX IF NOT EXISTS beacon_brain_facts_citations_idx
  ON beacon_brain_facts (citation_count DESC, last_cited_at DESC)
  WHERE soft_deleted_at IS NULL AND confidence_state = 'confirmed';
