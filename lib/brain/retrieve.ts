/**
 * Wave-1 (Beam/Keeper hybrid retrieval) — query-time fact retrieval.
 *
 * The Keeper's read paths used to be either (a) "give me all confirmed
 * facts for this customer" (loadBrainForPrompt → getFactsForCustomer) or
 * (b) "give me confirmed facts whose value contains $substring"
 * (searchFacts → ILIKE). Neither ranks against the actual question
 * Beam is being asked, so:
 *   - (a) dumps the full ~40-fact context on the model every turn,
 *     wasting tokens and diluting attention
 *   - (b) misses semantic matches (paraphrases, synonyms)
 *
 * This module adds a hybrid path: combine pgvector cosine (semantic)
 * with Postgres tsvector match (keyword) via RRF, then run the merged
 * candidates through Voyage rerank-2.5-lite. The output is a tight
 * top-K (default 5) of the facts most relevant to the question.
 *
 * Pipeline:
 *   embedding cosine (top-50)  ─┐
 *                                ├─→ RRF merge → top-50 candidates
 *   tsvector @@ tsquery (top-50)┘                    │
 *                                                    ▼
 *                                          Voyage rerank-2.5-lite
 *                                                    │
 *                                                    ▼
 *                                                  top-K
 *
 * Soft-fail behavior at every stage. If Voyage is down, we still return
 * the RRF-merged candidates trimmed to topK (no rerank). If pgvector
 * fails, we fall back to keyword only. If both retrieval signals fail,
 * we return [] and the caller falls back to its pre-Wave-1 behavior.
 */

import { getSql } from "../customer/postgres";
import type { BrainFact } from "./types";
import {
  embedQuery,
  formatVectorLiteral,
  factEmbeddingText,
  rerankDocuments,
} from "./embeddings";

/* ────────────────────────────────────────────────────────────────────────
 * Filter shape
 * ──────────────────────────────────────────────────────────────────────── */

export interface FactRetrievalFilters {
  /** Scope to a single customer. Required for per-customer retrieval
   *  (read_customer_brain). Omit for cross-book search (query_brain). */
  customer_id?: string;
  /** Restrict to a topic_category. Stacked with subcategory filter. */
  topic_category?: string;
  /** Restrict to a topic_subcategory. */
  topic_subcategory?: string;
  /** Restrict to a single field_name within a subcategory. */
  field_name?: string;
  /** Numeric range filters (for staff_count, location_count, etc.). */
  value_numeric_gte?: number;
  value_numeric_lte?: number;
}

export interface HybridRetrievalOptions extends FactRetrievalFilters {
  /** How many candidates each retrieval stage pulls before merge. Default 50. */
  candidatesPerStage?: number;
  /** Final result size after rerank. Default 5. */
  topK?: number;
  /** Force the rerank pass off — e.g., for low-latency callers that don't
   *  need precision. Default false (rerank ON). */
  skipRerank?: boolean;
}

export interface ScoredFact {
  fact: BrainFact;
  /** Score from RRF merge stage (sum of reciprocal ranks across signals). */
  rrf_score: number;
  /** Voyage rerank relevance score, 0-1. Null when rerank skipped/failed. */
  rerank_score: number | null;
  /** Which retrieval stages surfaced this fact (debug + telemetry). */
  matched_via: Array<"embedding" | "keyword">;
}

export interface HybridRetrievalResult {
  facts: ScoredFact[];
  /** Per-stage timing in ms — useful for the latency budget audit. */
  timing: {
    embedding_ms: number;
    keyword_ms: number;
    rerank_ms: number;
    total_ms: number;
  };
  /** Whether each stage actually ran (vs soft-failed / was skipped). */
  ran: {
    embedding: boolean;
    keyword: boolean;
    rerank: boolean;
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Stage 1a — pgvector cosine search
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Embed the query and pull the top-N most cosine-similar confirmed facts.
 * Mirrors findSemanticNeighbor's query shape from repo.ts but returns the
 * full BrainFact row, not just a fact_id stub.
 *
 * Returns [] on any failure (no Voyage key, embed error, no SQL).
 * Caller should treat empty array as "this signal soft-failed".
 */
export async function searchByEmbedding(
  query: string,
  filters: FactRetrievalFilters,
  limit: number = 50,
): Promise<BrainFact[]> {
  const sql = getSql();
  if (!sql) return [];
  if (!query || !query.trim()) return [];

  // Use the query-side input_type for asymmetric retrieval. The stored
  // facts were embedded with input_type="document"; using "query" on the
  // search side is what voyage-3-lite expects.
  const embedded = await embedQuery(query);
  if (!embedded) return [];

  const vec = formatVectorLiteral(embedded.embedding);
  const cust = filters.customer_id ?? null;
  const cat = filters.topic_category ?? null;
  const sub = filters.topic_subcategory ?? null;
  const field = filters.field_name ?? null;
  const numGte =
    typeof filters.value_numeric_gte === "number"
      ? filters.value_numeric_gte
      : null;
  const numLte =
    typeof filters.value_numeric_lte === "number"
      ? filters.value_numeric_lte
      : null;

  try {
    const rows = (await sql`
      SELECT *, 1 - (embedding <=> ${vec}::vector) AS similarity
      FROM beacon_brain_facts
      WHERE confidence_state = 'confirmed'
        AND soft_deleted_at IS NULL
        AND (sunset_at IS NULL OR sunset_at > NOW())
        AND superseded_by IS NULL
        AND embedding IS NOT NULL
        AND (${cust}::text IS NULL OR customer_id = ${cust})
        AND (${cat}::text  IS NULL OR topic_category = ${cat})
        AND (${sub}::text  IS NULL OR topic_subcategory = ${sub})
        AND (${field}::text IS NULL OR field_name = ${field})
        AND (${numGte}::int IS NULL OR value_numeric >= ${numGte})
        AND (${numLte}::int IS NULL OR value_numeric <= ${numLte})
      ORDER BY embedding <=> ${vec}::vector
      LIMIT ${limit}
    `) as BrainFact[];
    return rows;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[retrieve] embedding search threw: ${msg}`);
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Stage 1b — Postgres FTS keyword search
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Run plainto_tsquery against the GENERATED search_tsv column (added in
 * the Wave-1 hybrid-fts migration). Returns the top-N confirmed facts by
 * ts_rank_cd, scoped to the same filter shape as searchByEmbedding.
 *
 * Why plainto_tsquery vs websearch_to_tsquery? plainto is more
 * forgiving — it tokenizes any free-form text without requiring quotes
 * for phrases. Beam's questions are conversational, not search-engine
 * syntax. We sacrifice phrase precision for query robustness; the
 * rerank stage will catch the cases where a too-loose match misranks.
 */
export async function searchByKeyword(
  query: string,
  filters: FactRetrievalFilters,
  limit: number = 50,
): Promise<BrainFact[]> {
  const sql = getSql();
  if (!sql) return [];
  if (!query || !query.trim()) return [];

  const cust = filters.customer_id ?? null;
  const cat = filters.topic_category ?? null;
  const sub = filters.topic_subcategory ?? null;
  const field = filters.field_name ?? null;
  const numGte =
    typeof filters.value_numeric_gte === "number"
      ? filters.value_numeric_gte
      : null;
  const numLte =
    typeof filters.value_numeric_lte === "number"
      ? filters.value_numeric_lte
      : null;

  try {
    const rows = (await sql`
      SELECT *, ts_rank_cd(search_tsv, plainto_tsquery('english', ${query})) AS rank
      FROM beacon_brain_facts
      WHERE confidence_state = 'confirmed'
        AND soft_deleted_at IS NULL
        AND (sunset_at IS NULL OR sunset_at > NOW())
        AND superseded_by IS NULL
        AND search_tsv @@ plainto_tsquery('english', ${query})
        AND (${cust}::text IS NULL OR customer_id = ${cust})
        AND (${cat}::text  IS NULL OR topic_category = ${cat})
        AND (${sub}::text  IS NULL OR topic_subcategory = ${sub})
        AND (${field}::text IS NULL OR field_name = ${field})
        AND (${numGte}::int IS NULL OR value_numeric >= ${numGte})
        AND (${numLte}::int IS NULL OR value_numeric <= ${numLte})
      ORDER BY rank DESC, updated_at DESC
      LIMIT ${limit}
    `) as BrainFact[];
    return rows;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[retrieve] keyword search threw: ${msg}`);
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Stage 2 — RRF merge
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Reciprocal Rank Fusion. Standard formula:
 *
 *   score(d) = Σ over rankings R: 1 / (k + rank_R(d))
 *
 * where k=60 is the textbook constant (Cormack et al. 2009). The
 * reciprocal-rank shape rewards docs that show up near the top of any
 * one ranking even if they're missing from the other, which is exactly
 * what we want — a literal-token match in keyword search that doesn't
 * register on cosine (or vice versa) shouldn't be penalized.
 *
 * Returns a Map keyed by fact_id with the merged score + which signals
 * surfaced each fact.
 */
export const RRF_K = 60;

export interface MergeEntry {
  fact: BrainFact;
  rrf_score: number;
  matched_via: Array<"embedding" | "keyword">;
}

/**
 * Exported for unit testing. Production callers should use
 * retrieveFactsHybrid which composes mergeRRF with the I/O stages.
 */
export function mergeRRF(
  embeddingHits: BrainFact[],
  keywordHits: BrainFact[],
): MergeEntry[] {
  const byId = new Map<string, MergeEntry>();

  for (let i = 0; i < embeddingHits.length; i++) {
    const f = embeddingHits[i];
    const score = 1 / (RRF_K + i + 1); // ranks are 1-indexed in the formula
    const existing = byId.get(f.fact_id);
    if (existing) {
      existing.rrf_score += score;
      if (!existing.matched_via.includes("embedding")) {
        existing.matched_via.push("embedding");
      }
    } else {
      byId.set(f.fact_id, {
        fact: f,
        rrf_score: score,
        matched_via: ["embedding"],
      });
    }
  }

  for (let i = 0; i < keywordHits.length; i++) {
    const f = keywordHits[i];
    const score = 1 / (RRF_K + i + 1);
    const existing = byId.get(f.fact_id);
    if (existing) {
      existing.rrf_score += score;
      if (!existing.matched_via.includes("keyword")) {
        existing.matched_via.push("keyword");
      }
    } else {
      byId.set(f.fact_id, {
        fact: f,
        rrf_score: score,
        matched_via: ["keyword"],
      });
    }
  }

  return Array.from(byId.values()).sort((a, b) => b.rrf_score - a.rrf_score);
}

/* ────────────────────────────────────────────────────────────────────────
 * Stage 3 — Voyage rerank
 *
 * Take the RRF-merged top-N candidates, compose the rerank input string
 * per candidate (using the same factEmbeddingText shape that produced
 * the stored embedding — keeps the model on familiar ground), and ask
 * Voyage to score them against the query. Sort by relevance_score
 * descending, take topK.
 *
 * On soft-fail (no Voyage key, API error), return the input ordering
 * unchanged. The rerank_score on each returned fact will be null —
 * caller can detect this and treat the result as "RRF only".
 * ──────────────────────────────────────────────────────────────────────── */

async function applyRerank(
  query: string,
  candidates: MergeEntry[],
  topK: number,
): Promise<{ scored: ScoredFact[]; ran: boolean }> {
  if (candidates.length === 0) return { scored: [], ran: false };
  if (candidates.length === 1) {
    return {
      scored: [
        {
          fact: candidates[0].fact,
          rrf_score: candidates[0].rrf_score,
          rerank_score: null,
          matched_via: candidates[0].matched_via,
        },
      ],
      ran: false,
    };
  }

  const documents = candidates.map((c) =>
    factEmbeddingText(
      c.fact.topic_subcategory,
      c.fact.field_name,
      c.fact.value,
    ),
  );

  const reranked = await rerankDocuments(query, documents, {
    topK: Math.min(topK, candidates.length),
  });

  if (!reranked) {
    // Soft-fail — fall back to RRF order.
    const scored: ScoredFact[] = candidates.slice(0, topK).map((c) => ({
      fact: c.fact,
      rrf_score: c.rrf_score,
      rerank_score: null,
      matched_via: c.matched_via,
    }));
    return { scored, ran: false };
  }

  const scored: ScoredFact[] = reranked.map((r) => {
    const src = candidates[r.index];
    return {
      fact: src.fact,
      rrf_score: src.rrf_score,
      rerank_score: r.relevance_score,
      matched_via: src.matched_via,
    };
  });
  return { scored, ran: true };
}

/* ────────────────────────────────────────────────────────────────────────
 * Top-level orchestrator
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The Wave-1 hybrid retrieval entry point. Callers (read_customer_brain,
 * query_brain, context loaders) hand a free-form query + filters and get
 * back a tight scored ranking.
 *
 * Empty query → empty result. We don't fall back to "all confirmed facts"
 * here; that path stays in loadBrainForPrompt for the no-question case
 * (e.g., initial Customer 360 panel load).
 */
export async function retrieveFactsHybrid(
  query: string,
  options: HybridRetrievalOptions = {},
): Promise<HybridRetrievalResult> {
  const candidatesPerStage = options.candidatesPerStage ?? 50;
  const topK = options.topK ?? 5;
  const skipRerank = options.skipRerank ?? false;

  const filters: FactRetrievalFilters = {
    customer_id: options.customer_id,
    topic_category: options.topic_category,
    topic_subcategory: options.topic_subcategory,
    field_name: options.field_name,
    value_numeric_gte: options.value_numeric_gte,
    value_numeric_lte: options.value_numeric_lte,
  };

  const t0 = Date.now();
  if (!query || !query.trim()) {
    return {
      facts: [],
      timing: { embedding_ms: 0, keyword_ms: 0, rerank_ms: 0, total_ms: 0 },
      ran: { embedding: false, keyword: false, rerank: false },
    };
  }

  // Stage 1 — run embedding + keyword in parallel.
  const tEmb0 = Date.now();
  const tKw0 = Date.now();
  const [embeddingHits, keywordHits] = await Promise.all([
    searchByEmbedding(query, filters, candidatesPerStage),
    searchByKeyword(query, filters, candidatesPerStage),
  ]);
  const embedding_ms = Date.now() - tEmb0;
  const keyword_ms = Date.now() - tKw0;

  const ranEmbedding = embeddingHits.length > 0;
  const ranKeyword = keywordHits.length > 0;

  // Stage 2 — RRF merge.
  const merged = mergeRRF(embeddingHits, keywordHits);

  // Stage 3 — rerank (optional).
  const tRerank0 = Date.now();
  let scored: ScoredFact[];
  let ranRerank = false;
  if (skipRerank || merged.length <= 1) {
    scored = merged.slice(0, topK).map((c) => ({
      fact: c.fact,
      rrf_score: c.rrf_score,
      rerank_score: null,
      matched_via: c.matched_via,
    }));
  } else {
    const out = await applyRerank(query, merged, topK);
    scored = out.scored;
    ranRerank = out.ran;
  }
  const rerank_ms = Date.now() - tRerank0;

  return {
    facts: scored,
    timing: {
      embedding_ms,
      keyword_ms,
      rerank_ms,
      total_ms: Date.now() - t0,
    },
    ran: {
      embedding: ranEmbedding,
      keyword: ranKeyword,
      rerank: ranRerank,
    },
  };
}
