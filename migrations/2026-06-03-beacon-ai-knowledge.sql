-- Phase G — Beacon AI Knowledge Base.
--
-- Persistent document store that Beacon AI reads from on every question.
-- Each doc is markdown content with a slug, scope tags (which agents see
-- it — "miss-payment-overview", "customer-360", "escalation-overview",
-- etc., or "all" for cross-agent docs), and a tsvector for full-text
-- search.
--
-- Why FTS + Postgres instead of a vector DB:
--   - Corpus stays small (target: 20-100 docs). FTS handles this size
--     well; recall is good for keyword-rich queries like "what's the
--     ICP framework" or "how do we decide auto-debit".
--   - No new infra. pgvector can layer on later if semantic gaps appear.
--   - Citation chips render the doc's title + section. Both work with
--     FTS hits directly; we don't need embedding similarity scores.
--
-- The retrieval pipeline (lib/ai/knowledge.ts):
--   1. Loader fires searchDocs(query, scope) per request
--   2. tsvector match filtered by scope_tags overlap
--   3. Top-3 chunks land under CONTEXT._knowledge_base with [cite:kb:<slug>]
--      citation keys
--   4. Beacon AI cites them inline; client renders chips that open the
--      source doc in /admin/knowledge/<id>

CREATE TABLE IF NOT EXISTS beacon_ai_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable url-friendly identifier (used in citation chips). Required
  -- unique. Example: "icp-framework", "module-02-decline-scripts",
  -- "beacon-product-overview".
  slug TEXT NOT NULL UNIQUE,

  -- Human-readable doc title for the citation chip popover. Required.
  title TEXT NOT NULL,

  -- Markdown body. No size limit on Postgres TEXT; keep individual docs
  -- under ~50KB so retrieval pulls clean chunks. Larger docs should be
  -- split across multiple rows with shared scope_tags.
  body TEXT NOT NULL,

  -- Optional section anchor for citation precision. When the doc covers
  -- multiple topics ("Module 02 — full framework"), the section field
  -- lets a citation point at a specific subsection ("the 4 carve-outs").
  -- Free-form; the model uses whatever the author wrote.
  section TEXT,

  -- Which Beacon AI scopes should see this doc on their retrieval.
  -- Allowed values: 'all' | one of the AiScope kinds: 'inbox',
  -- 'customer-360', 'customer-book', 'performance-landing',
  -- 'performance-report', 'escalation-overview', 'post-payment-book',
  -- 'post-payment-customer', 'miss-payment-overview'.
  -- 'all' = doc shows up on every scope's retrieval.
  -- Multiple tags allowed for cross-cutting docs (e.g. an ops runbook
  -- relevant to both miss-payment-overview + escalation-overview).
  scope_tags TEXT[] NOT NULL DEFAULT ARRAY['all'],

  -- Optimistic concurrency + audit trail. Bump on every update.
  version INT NOT NULL DEFAULT 1,

  -- Editor's email (admin who wrote/last-touched the doc). Optional;
  -- nullable for migrations that seed without an attributable author.
  last_edited_by TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Materialized full-text vector. Postgres maintains this on insert /
  -- update via the trigger below. Indexed for fast ts_rank queries.
  -- Weight: title (A) > section (B) > body (C). Means a title match
  -- ranks higher than a body match for the same term.
  search_vec tsvector
);

-- GIN index for fast tsvector search. Covers any to_tsquery() pattern.
CREATE INDEX IF NOT EXISTS beacon_ai_docs_search_vec_idx
  ON beacon_ai_docs USING GIN (search_vec);

-- Per-tag index for scope-filtered retrieval. Lets us do
-- "WHERE scope_tags && ARRAY[$1]::text[]" without scanning every row.
CREATE INDEX IF NOT EXISTS beacon_ai_docs_scope_tags_idx
  ON beacon_ai_docs USING GIN (scope_tags);

-- Index on updated_at for the admin list view (sort newest first).
CREATE INDEX IF NOT EXISTS beacon_ai_docs_updated_at_idx
  ON beacon_ai_docs (updated_at DESC);

-- Function + trigger to maintain search_vec on insert/update. Pulled
-- into its own function so the weighting logic lives in one place if we
-- ever tune it.
CREATE OR REPLACE FUNCTION beacon_ai_docs_update_search_vec()
RETURNS trigger AS $$
BEGIN
  NEW.search_vec :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.section, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.body, '')), 'C');
  NEW.updated_at := now();
  NEW.version := COALESCE(OLD.version, 0) + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop + recreate to be idempotent. Migrations run via the home-rolled
-- runner which doesn't track trigger drops, so we always start clean.
DROP TRIGGER IF EXISTS beacon_ai_docs_search_vec_trigger ON beacon_ai_docs;
CREATE TRIGGER beacon_ai_docs_search_vec_trigger
  BEFORE INSERT OR UPDATE ON beacon_ai_docs
  FOR EACH ROW
  EXECUTE FUNCTION beacon_ai_docs_update_search_vec();
