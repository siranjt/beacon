-- Wave 2b — semantic dedup via pgvector embeddings.
--
-- Adds an `embedding vector(1024)` column to beacon_brain_facts.
-- Voyage's voyage-3-lite returns 1024-dim embeddings; if we ever switch
-- to voyage-3 (1024) or voyage-3-large (2048), the dim stays compatible
-- or requires a fresh column. Keeping 1024 for now.
--
-- Indexed via ivfflat with cosine distance — good balance of recall and
-- speed for our scale (a few thousand facts/customer ceiling). HNSW would
-- be lower latency but ivfflat is more storage-efficient and our queries
-- always include customer_id filter so the recall hit is minimal.
--
-- Conflict-detection query (used by writeBrainFact):
--   SELECT fact_id, 1 - (embedding <=> $1) AS similarity
--   FROM beacon_brain_facts
--   WHERE customer_id = $2
--     AND confidence_state = 'confirmed'
--     AND soft_deleted_at IS NULL
--     AND embedding IS NOT NULL
--   ORDER BY embedding <=> $1
--   LIMIT 1;
--
-- If similarity >= 0.92, we block the insert (unless force=true).

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE beacon_brain_facts
  ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- ivfflat index. lists=100 is a reasonable default for our scale
-- (~10k facts at maturity). Tune later if recall feels off.
-- Cosine distance because Voyage embeddings are unit-normalized.
CREATE INDEX IF NOT EXISTS beacon_brain_facts_embedding_idx
  ON beacon_brain_facts
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
