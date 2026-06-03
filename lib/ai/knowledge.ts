/**
 * Beacon AI Knowledge Base — Phase G.
 *
 * Persistent doc store + retrieval. Every Beacon AI question pulls top-K
 * relevant docs scoped to the surface the user is on (e.g. /miss-payment
 * questions only see docs tagged with miss-payment-overview or 'all').
 *
 * Storage layer: beacon_ai_docs Postgres table (see migration
 * 2026-06-03-beacon-ai-knowledge.sql). Full-text search via tsvector +
 * GIN. ts_rank for relevance ordering. Per-tag GIN for scope filtering.
 *
 * Retrieval contract:
 *   - searchDocs(query, scope, limit=3) returns ranked KnowledgeChunk
 *     entries with title, slug, section, an excerpt of the body, and a
 *     numeric relevance score.
 *   - The context loaders embed these in the CONTEXT JSON under
 *     `_knowledge_base`. The citation lookup is built from the chunk's
 *     slug so the model can emit [cite:kb:icp-framework] markers.
 *
 * Admin layer: createDoc / updateDoc / deleteDoc / listDocs / getDoc.
 * Used by app/admin/knowledge/ CRUD page. Auth is the page's
 * responsibility — these helpers don't gate by role.
 */

import "server-only";
import { neon } from "@neondatabase/serverless";
import type { AiScope } from "./scopes";

function getDbUrl(): string | null {
  return (
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    null
  );
}

let _sql: ReturnType<typeof neon> | null = null;
function getSql() {
  if (_sql) return _sql;
  const url = getDbUrl();
  if (!url) return null;
  _sql = neon(url);
  return _sql;
}

export interface KnowledgeDoc {
  id: string;
  slug: string;
  title: string;
  body: string;
  section: string | null;
  scope_tags: string[];
  version: number;
  last_edited_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Retrieval-shape excerpt. Trimmed to ~500 chars to keep prompt size
 * predictable; the full body is reachable via the admin UI for users
 * who follow the citation chip.
 */
export interface KnowledgeChunk {
  slug: string;
  title: string;
  section: string | null;
  excerpt: string;
  /** Postgres ts_rank score. Higher = more relevant. */
  rank: number;
}

const RETRIEVAL_LIMIT_DEFAULT = 3;
const EXCERPT_MAX_CHARS = 500;

/**
 * Resolve the AiScope.kind that should be used for scope-tag filtering.
 * AiScope is a discriminated union — we only need the `kind` field for
 * this lookup. 'hidden' returns null = skip KB retrieval entirely.
 */
function scopeKey(scope: AiScope | null | undefined): string | null {
  if (!scope) return null;
  if (scope.kind === "hidden") return null;
  return scope.kind;
}

/**
 * Build the tsvector query string from a free-form user question. We
 * extract individual words (alphanumeric, len>=3), lowercase them,
 * OR-join with " | " so any term match scores. websearch_to_tsquery
 * would be cleaner but isn't available pre-PG11.
 *
 * Returns null when the query has no usable terms (all stopwords or
 * <3-char words) — caller short-circuits retrieval in that case.
 */
function buildTsQuery(question: string): string | null {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3)
    .slice(0, 12); // cap to keep query plan simple
  if (terms.length === 0) return null;
  return terms.join(" | ");
}

/**
 * Trim a body to an excerpt that's most relevant to the query. Picks
 * the first paragraph containing any query term; falls back to body
 * head. Capped at EXCERPT_MAX_CHARS.
 */
function buildExcerpt(body: string, question: string): string {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3);
  if (terms.length === 0) {
    return body.slice(0, EXCERPT_MAX_CHARS).trim();
  }
  // Split body on blank lines; find first paragraph containing any term.
  const paragraphs = body.split(/\n\n+/);
  for (const p of paragraphs) {
    const lower = p.toLowerCase();
    if (terms.some((t) => lower.includes(t))) {
      return p.slice(0, EXCERPT_MAX_CHARS).trim();
    }
  }
  return body.slice(0, EXCERPT_MAX_CHARS).trim();
}

/**
 * Search docs for relevance to the user's question, filtered to the
 * current scope. Returns top-K ranked chunks. Empty array on null DB,
 * empty query, or zero matches.
 */
export async function searchDocs(
  question: string,
  scope: AiScope | null | undefined,
  limit: number = RETRIEVAL_LIMIT_DEFAULT,
): Promise<KnowledgeChunk[]> {
  const sql = getSql();
  if (!sql) return [];
  const scopeKind = scopeKey(scope);
  if (!scopeKind) return [];
  const tsQuery = buildTsQuery(question);
  if (!tsQuery) return [];

  try {
    const rows = (await sql`
      SELECT
        slug,
        title,
        body,
        section,
        ts_rank(search_vec, to_tsquery('english', ${tsQuery})) AS rank
      FROM beacon_ai_docs
      WHERE search_vec @@ to_tsquery('english', ${tsQuery})
        AND (scope_tags && ARRAY['all', ${scopeKind}]::text[])
      ORDER BY rank DESC
      LIMIT ${limit}
    `) as Array<{
      slug: string;
      title: string;
      body: string;
      section: string | null;
      rank: number;
    }>;

    return rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      section: r.section,
      excerpt: buildExcerpt(r.body, question),
      rank: Number(r.rank) || 0,
    }));
  } catch (err) {
    // tsquery parse errors (rare — our buildTsQuery emits safe input)
    // shouldn't kill the user's question. Log + return empty.
    console.warn("[knowledge] searchDocs failed:", err);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────
// Admin CRUD — used by /admin/knowledge
// ────────────────────────────────────────────────────────────────────

export interface ListDocsArgs {
  /** Optional substring filter on title or slug. */
  q?: string;
  /** Optional filter by scope tag (matches 'all' or the specific tag). */
  scope?: string;
  limit?: number;
  offset?: number;
}

export async function listDocs(
  args: ListDocsArgs = {},
): Promise<KnowledgeDoc[]> {
  const sql = getSql();
  if (!sql) return [];
  const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
  const offset = Math.max(0, args.offset ?? 0);
  const qPattern = args.q ? `%${args.q.toLowerCase()}%` : null;
  const scope = args.scope || null;

  try {
    if (qPattern && scope) {
      return (await sql`
        SELECT id, slug, title, body, section, scope_tags, version,
               last_edited_by,
               created_at::text AS created_at,
               updated_at::text AS updated_at
        FROM beacon_ai_docs
        WHERE (LOWER(title) LIKE ${qPattern} OR LOWER(slug) LIKE ${qPattern})
          AND (scope_tags && ARRAY[${scope}]::text[])
        ORDER BY updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as KnowledgeDoc[];
    }
    if (qPattern) {
      return (await sql`
        SELECT id, slug, title, body, section, scope_tags, version,
               last_edited_by,
               created_at::text AS created_at,
               updated_at::text AS updated_at
        FROM beacon_ai_docs
        WHERE (LOWER(title) LIKE ${qPattern} OR LOWER(slug) LIKE ${qPattern})
        ORDER BY updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as KnowledgeDoc[];
    }
    if (scope) {
      return (await sql`
        SELECT id, slug, title, body, section, scope_tags, version,
               last_edited_by,
               created_at::text AS created_at,
               updated_at::text AS updated_at
        FROM beacon_ai_docs
        WHERE scope_tags && ARRAY[${scope}]::text[]
        ORDER BY updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as KnowledgeDoc[];
    }
    return (await sql`
      SELECT id, slug, title, body, section, scope_tags, version,
             last_edited_by,
             created_at::text AS created_at,
             updated_at::text AS updated_at
      FROM beacon_ai_docs
      ORDER BY updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as KnowledgeDoc[];
  } catch (err) {
    console.warn("[knowledge] listDocs failed:", err);
    return [];
  }
}

export async function getDoc(id: string): Promise<KnowledgeDoc | null> {
  const sql = getSql();
  if (!sql) return null;
  try {
    const rows = (await sql`
      SELECT id, slug, title, body, section, scope_tags, version,
             last_edited_by,
             created_at::text AS created_at,
             updated_at::text AS updated_at
      FROM beacon_ai_docs
      WHERE id = ${id}
      LIMIT 1
    `) as KnowledgeDoc[];
    return rows[0] ?? null;
  } catch (err) {
    console.warn("[knowledge] getDoc failed:", err);
    return null;
  }
}

export async function getDocBySlug(slug: string): Promise<KnowledgeDoc | null> {
  const sql = getSql();
  if (!sql) return null;
  try {
    const rows = (await sql`
      SELECT id, slug, title, body, section, scope_tags, version,
             last_edited_by,
             created_at::text AS created_at,
             updated_at::text AS updated_at
      FROM beacon_ai_docs
      WHERE slug = ${slug}
      LIMIT 1
    `) as KnowledgeDoc[];
    return rows[0] ?? null;
  } catch (err) {
    console.warn("[knowledge] getDocBySlug failed:", err);
    return null;
  }
}

export interface CreateDocInput {
  slug: string;
  title: string;
  body: string;
  section?: string | null;
  scope_tags?: string[];
  last_edited_by?: string | null;
}

export async function createDoc(input: CreateDocInput): Promise<KnowledgeDoc | null> {
  const sql = getSql();
  if (!sql) return null;
  const tags =
    input.scope_tags && input.scope_tags.length > 0
      ? input.scope_tags
      : ["all"];
  try {
    const rows = (await sql`
      INSERT INTO beacon_ai_docs (slug, title, body, section, scope_tags, last_edited_by)
      VALUES (${input.slug}, ${input.title}, ${input.body},
              ${input.section ?? null}, ${tags as any}, ${input.last_edited_by ?? null})
      RETURNING id, slug, title, body, section, scope_tags, version,
                last_edited_by,
                created_at::text AS created_at,
                updated_at::text AS updated_at
    `) as KnowledgeDoc[];
    return rows[0] ?? null;
  } catch (err) {
    console.warn("[knowledge] createDoc failed:", err);
    throw err;
  }
}

export interface UpdateDocInput {
  title?: string;
  body?: string;
  section?: string | null;
  scope_tags?: string[];
  last_edited_by?: string | null;
}

export async function updateDoc(
  id: string,
  patch: UpdateDocInput,
): Promise<KnowledgeDoc | null> {
  const sql = getSql();
  if (!sql) return null;
  // Build the SET clause dynamically. Neon's tagged-template SQL doesn't
  // support raw fragment composition cleanly, so we do field-at-a-time
  // updates wrapped in a single transaction-style block. Each helper
  // call hits the trigger which bumps version + updated_at.
  try {
    if (patch.title !== undefined) {
      await sql`UPDATE beacon_ai_docs SET title = ${patch.title} WHERE id = ${id}`;
    }
    if (patch.body !== undefined) {
      await sql`UPDATE beacon_ai_docs SET body = ${patch.body} WHERE id = ${id}`;
    }
    if (patch.section !== undefined) {
      await sql`UPDATE beacon_ai_docs SET section = ${patch.section} WHERE id = ${id}`;
    }
    if (patch.scope_tags !== undefined) {
      await sql`UPDATE beacon_ai_docs SET scope_tags = ${patch.scope_tags as any}::text[] WHERE id = ${id}`;
    }
    if (patch.last_edited_by !== undefined) {
      await sql`UPDATE beacon_ai_docs SET last_edited_by = ${patch.last_edited_by} WHERE id = ${id}`;
    }
    return getDoc(id);
  } catch (err) {
    console.warn("[knowledge] updateDoc failed:", err);
    throw err;
  }
}

export async function deleteDoc(id: string): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  try {
    const rows = (await sql`
      DELETE FROM beacon_ai_docs WHERE id = ${id} RETURNING id
    `) as Array<{ id: string }>;
    return rows.length > 0;
  } catch (err) {
    console.warn("[knowledge] deleteDoc failed:", err);
    return false;
  }
}

/**
 * Allowed scope_tag values. Mirrors AiScope.kind plus 'all'. The admin
 * UI's scope picker reads from this list.
 */
export const ALLOWED_SCOPE_TAGS = [
  "all",
  "inbox",
  "customer-360",
  "customer-book",
  "performance-landing",
  "performance-report",
  "escalation-overview",
  "post-payment-book",
  "post-payment-customer",
  "miss-payment-overview",
] as const;
export type AllowedScopeTag = (typeof ALLOWED_SCOPE_TAGS)[number];

export function isAllowedScopeTag(tag: string): tag is AllowedScopeTag {
  return (ALLOWED_SCOPE_TAGS as readonly string[]).includes(tag);
}
