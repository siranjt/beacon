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
-- Implementation note (#fix-for-migration-runner):
--   The home-rolled migration runner splits on `;` at end of line and
--   can't parse PL/pgSQL function bodies (which have internal `;`
--   between statements wrapped in $$ $$). To avoid that, this schema
--   uses a GENERATED STORED column for search_vec instead of a trigger.
--   Postgres 12+ (Neon runs 16+) supports this. Version + updated_at
--   are maintained explicitly in lib/ai/knowledge.ts updateDoc() rather
--   than via trigger.

CREATE TABLE IF NOT EXISTS beacon_ai_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable url-friendly identifier (used in citation chips). Required
  -- unique. Example: "icp-framework", "module-02-decline-scripts".
  slug TEXT NOT NULL UNIQUE,

  -- Human-readable doc title for the citation chip popover. Required.
  title TEXT NOT NULL,

  -- Markdown body. Keep individual docs under ~50KB so retrieval pulls
  -- clean chunks. Larger docs should be split across multiple rows
  -- with shared scope_tags.
  body TEXT NOT NULL,

  -- Optional section anchor for citation precision. Free-form.
  section TEXT,

  -- Which Beacon AI scopes should see this doc on retrieval.
  -- Allowed values: 'all' | one of the AiScope kinds. Multiple tags
  -- allowed for cross-cutting docs.
  scope_tags TEXT[] NOT NULL DEFAULT ARRAY['all'],

  -- Optimistic concurrency + audit trail. lib/ai/knowledge.ts bumps
  -- this on every update (one bump per save, not per field).
  version INT NOT NULL DEFAULT 1,

  -- Editor's email (admin who wrote/last-touched the doc).
  last_edited_by TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Materialized full-text vector — Postgres maintains this
  -- automatically on insert/update because it's GENERATED STORED.
  -- Weight: title (A) > section (B) > body (C) so title matches
  -- outrank body matches for the same term in ts_rank.
  search_vec tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(section, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED
);

-- GIN index for fast tsvector search. Covers any to_tsquery() pattern.
CREATE INDEX IF NOT EXISTS beacon_ai_docs_search_vec_idx
  ON beacon_ai_docs USING GIN (search_vec);

-- Per-tag index for scope-filtered retrieval.
CREATE INDEX IF NOT EXISTS beacon_ai_docs_scope_tags_idx
  ON beacon_ai_docs USING GIN (scope_tags);

-- Index on updated_at for the admin list view (sort newest first).
CREATE INDEX IF NOT EXISTS beacon_ai_docs_updated_at_idx
  ON beacon_ai_docs (updated_at DESC);
