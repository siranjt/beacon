-- Wave-1 (Beam/Keeper hybrid retrieval) — BM25/FTS over fact text.
--
-- Pairs with Wave 2b (embeddings) to enable hybrid retrieval. Pure
-- embedding cosine misses literal-token matches (e.g., AM asks
-- "Mindbody" and a fact mentions "Mindbody" verbatim — cosine might
-- rank a semantically-similar Square fact higher). BM25 keyword search
-- catches those literal matches.
--
-- The hybrid pipeline:
--   1. embedding cosine → top-50 candidates
--   2. tsvector match → top-50 candidates
--   3. RRF merge → unified ranking
--   4. Voyage rerank-2.5-lite → top-K (default 5)
--
-- Stored as a GENERATED column (memory-banked migration-runner limit:
-- `scripts/migrate.mjs` can't parse `$$ ... $$` blocks, so triggers are
-- out). GENERATED is also faster on write — Postgres re-derives only
-- when source columns change.
--
-- Weighted tsvector: value (A) > field_name (B) > topic_subcategory (C).
-- The fact body matters most; the classification dimensions provide
-- secondary context (cooks "Mindbody" inside `value` higher than
-- "Mindbody" buried in a subcategory label).
--
-- Search query shape (used by matchFactsByKeyword):
--   SELECT fact_id, ts_rank_cd(search_tsv, query) AS rank
--   FROM beacon_brain_facts, plainto_tsquery('english', $1) query
--   WHERE search_tsv @@ query
--     AND customer_id = $2
--     AND confidence_state = 'confirmed'
--     AND soft_deleted_at IS NULL
--   ORDER BY rank DESC
--   LIMIT 50;

ALTER TABLE beacon_brain_facts
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(value, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(field_name, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(topic_subcategory, '')), 'C')
  ) STORED;

-- GIN index for fast tsvector @@ tsquery lookups. Partial index on
-- live, confirmed facts only — the index is meaningless for soft-deleted
-- or candidate rows, and pruning them at index time keeps it small.
CREATE INDEX IF NOT EXISTS beacon_brain_facts_search_tsv_idx
  ON beacon_brain_facts
  USING GIN (search_tsv)
  WHERE soft_deleted_at IS NULL
    AND confidence_state = 'confirmed';
