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
import { callHaikuJson } from "../customer/llm";
import { getCachedContext } from "../ai/context-cache";

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
  /**
   * SMART-K2 — opt in to include facts the nightly stale-prune marked
   * stale. Default false: hybrid retrieval skips stale rows so Beam sees
   * only the live truth. Audit views can set this true.
   */
  includeStale?: boolean;
}

export interface HybridRetrievalOptions extends FactRetrievalFilters {
  /** How many candidates each retrieval stage pulls before merge. Default 50. */
  candidatesPerStage?: number;
  /** Final result size after rerank. Default 5. */
  topK?: number;
  /** Force the rerank pass off — e.g., for low-latency callers that don't
   *  need precision. Default false (rerank ON). */
  skipRerank?: boolean;
  /**
   * SMART-K3 — opt out of Haiku-driven query expansion. Default false
   * (expansion ON). Callers that don't want the extra ~$0.0008 Haiku
   * call should set this true — notably `query_brain` cross-book search
   * where the cost adds up across the full book sweep. Per-customer
   * read paths (read_customer_brain, Customer 360) keep expansion ON
   * because recall on a tight ~40-fact pool is the win.
   */
  skipExpansion?: boolean;
}

export interface ScoredFact {
  fact: BrainFact;
  /** Score from RRF merge stage (sum of reciprocal ranks across signals). */
  rrf_score: number;
  /** Voyage rerank relevance score, 0-1. Null when rerank skipped/failed. */
  rerank_score: number | null;
  /**
   * Which retrieval stages surfaced this fact (debug + telemetry).
   *
   * SMART-K4 — facts auto-pulled because a derived child landed in the
   * top-K get the "derived_expansion" tag (instead of embedding/keyword).
   * Lets the UI render "↑ parent of cited child" in the cite-chip "why"
   * trace and lets Beam's prompt block group parent + child together.
   */
  matched_via: Array<"embedding" | "keyword" | "derived_expansion">;
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
  /**
   * Roadmap-v2-4 — total unique candidates after the RRF merge, BEFORE
   * the rerank pass trimmed to topK. Used by the cite-chip "why" trace to
   * render "3rd of 47 candidates" style provenance to the AM.
   */
  candidate_pool_size: number;
}

/* ────────────────────────────────────────────────────────────────────────
 * Stage 0 — Haiku-driven query expansion (SMART-K3)
 *
 * Today the AM asks "what platform are they on?" but the stored fact says
 * "integration: GlossGenius". The keyword search misses (no "platform"
 * token) and embedding may or may not catch it depending on how aligned
 * the query- and document-side projections are. Generating 2 alternative
 * phrasings ("integration", "booking software") and OR-searching all of
 * them — original + expansions — materially lifts recall on top-5
 * retrieval.
 *
 * Cost shape: ~$0.0008 per Beam read when ANTHROPIC_API_KEY is set, and
 * cache-amortized across repeat questions (1h TTL). Soft-fails to
 * [original] on any error so Beam quality never regresses from where it
 * was before this lands.
 *
 * Gating: only expand when query length is in [5, 200] chars. Very short
 * queries don't carry enough signal for Haiku to paraphrase usefully and
 * very long queries already carry their own diverse vocabulary.
 * ──────────────────────────────────────────────────────────────────────── */

const EXPANSION_MIN_CHARS = 5;
const EXPANSION_MAX_CHARS = 200;
const EXPANSION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const EXPANSION_CACHE_PREFIX = "brain-query-expansion";

/**
 * SMART-K3 — the Haiku prompt. Kept verbatim here so changes to it are
 * version-controlled and grep-able (no docstring drift). Tight: one JSON
 * line out, no prose, no fences. Failing to parse soft-fails to no
 * expansion.
 */
const EXPANSION_SYSTEM_PROMPT =
  "Given an AM's question about a customer, return 2 alternative search phrasings that surface the same fact stored under different vocabulary. Output ONE JSON line: [\"phrase 1\", \"phrase 2\"]. No prose.";

function buildExpansionPrompt(query: string): string {
  return `Question: "${query}"`;
}

/**
 * Run the Haiku call (no cache). Exported separately so the cache wrapper
 * stays a thin shell that we can swap without rewriting the network path.
 *
 * Returns the expansion list (NOT including the original). Empty array
 * on any soft-fail.
 */
async function runExpansionViaHaiku(query: string): Promise<string[]> {
  const raw = await callHaikuJson<unknown>(
    {
      system: EXPANSION_SYSTEM_PROMPT,
      prompt: buildExpansionPrompt(query),
      maxTokens: 80,
      temperature: 0.2,
      timeoutMs: 4_000,
    },
    [],
  );
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    // Drop accidental echo of the original query.
    if (trimmed.toLowerCase() === query.trim().toLowerCase()) continue;
    out.push(trimmed);
    if (out.length >= 3) break; // cap at 3 expansions even if Haiku over-returns
  }
  return out;
}

/**
 * SMART-K3 — expand a free-form AM question into the original phrasing
 * plus 2-3 alternative phrasings that target the same fact under
 * different vocabulary.
 *
 * Always returns at least `[query]`. Soft-fails to `[query]` on any
 * error — Beam quality is never worse than pre-expansion.
 *
 * Cached for 1 hour per exact-string query — common questions ("what
 * platform are they on", "owner contact") skip the Haiku call after the
 * first hit in a warm Lambda.
 */
export async function expandQuery(query: string): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Gating: only worth the Haiku call when length is in the sweet spot.
  if (trimmed.length < EXPANSION_MIN_CHARS) return [trimmed];
  if (trimmed.length > EXPANSION_MAX_CHARS) return [trimmed];

  try {
    const cacheKey = `${EXPANSION_CACHE_PREFIX}:q=${trimmed}`;
    const expansions = await getCachedContext(
      cacheKey,
      () => runExpansionViaHaiku(trimmed),
      { ttlMs: EXPANSION_CACHE_TTL_MS },
    );
    return [trimmed, ...expansions];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[retrieve] query expansion soft-failed: ${msg}`);
    return [trimmed];
  }
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
  // SMART-K2 — default-skip stale facts so hybrid retrieval surfaces only
  // the live truth; audit callers opt in to includeStale=true.
  const includeStale = filters.includeStale ?? false;

  try {
    const rows = (await sql`
      SELECT *, 1 - (embedding <=> ${vec}::vector) AS similarity
      FROM beacon_brain_facts
      WHERE confidence_state = 'confirmed'
        AND soft_deleted_at IS NULL
        AND (sunset_at IS NULL OR sunset_at > NOW())
        AND superseded_by IS NULL
        AND (${includeStale}::boolean = true OR is_stale = false)
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
  // SMART-K2 — see searchByEmbedding above.
  const includeStale = filters.includeStale ?? false;

  try {
    const rows = (await sql`
      SELECT *, ts_rank_cd(search_tsv, plainto_tsquery('english', ${query})) AS rank
      FROM beacon_brain_facts
      WHERE confidence_state = 'confirmed'
        AND soft_deleted_at IS NULL
        AND (sunset_at IS NULL OR sunset_at > NOW())
        AND superseded_by IS NULL
        AND (${includeStale}::boolean = true OR is_stale = false)
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
 * Staged helper — used by the A/B rerank harness
 * ──────────────────────────────────────────────────────────────────────── */

export interface StagedRetrievalOptions extends FactRetrievalFilters {
  /** How many candidates each retrieval stage pulls before merge. Default 50. */
  candidatesPerStage?: number;
  /**
   * SMART-K3 — additional query phrasings to OR-search alongside the
   * primary query. Each phrasing fires its own embedding + keyword
   * search, and ALL hits feed into the same RRF merge (dedup'd by
   * fact_id). Empty/undefined skips expansion.
   */
  expansions?: string[];
}

export interface StagedRetrievalResult {
  /** Post-RRF candidates (sorted by rrf_score desc). */
  candidates: MergeEntry[];
  /** Per-stage timing in ms. */
  timing: {
    embedding_ms: number;
    keyword_ms: number;
  };
  /** Whether each retrieval stage actually returned hits. */
  ran: {
    embedding: boolean;
    keyword: boolean;
  };
}

/**
 * Run the hybrid pipeline up through RRF merge but stop BEFORE rerank.
 * Returns the candidate set so callers can run rerank zero, one, or many
 * times against the same candidates (e.g., the A/B harness reranks once
 * with rerank-2.5-lite and once with rerank-2.5 full).
 *
 * retrieveFactsHybrid composes this with applyRerank — keeping a single
 * source of truth for the staged behavior.
 */
export async function retrieveHybridStaged(
  query: string,
  options: StagedRetrievalOptions = {},
): Promise<StagedRetrievalResult> {
  const candidatesPerStage = options.candidatesPerStage ?? 50;

  const filters: FactRetrievalFilters = {
    customer_id: options.customer_id,
    topic_category: options.topic_category,
    topic_subcategory: options.topic_subcategory,
    field_name: options.field_name,
    value_numeric_gte: options.value_numeric_gte,
    value_numeric_lte: options.value_numeric_lte,
    // SMART-K2 — pass through audit-view opt-in so staged callers
    // (rerank harness, A/B tests) can render stale rows too.
    includeStale: options.includeStale,
  };

  if (!query || !query.trim()) {
    return {
      candidates: [],
      timing: { embedding_ms: 0, keyword_ms: 0 },
      ran: { embedding: false, keyword: false },
    };
  }

  // SMART-K3 — fire embedding + keyword search for the original query AND
  // every expansion phrasing in parallel. Each phrasing's pair of result
  // lists folds into the same RRF merge below, which already dedups by
  // fact_id (a fact surfaced under multiple phrasings stacks rank
  // contributions — exactly the recall lift we want).
  const phrasings: string[] = [query, ...(options.expansions ?? [])].filter(
    (p) => p && p.trim().length > 0,
  );

  const tEmb0 = Date.now();
  const tKw0 = Date.now();
  const perPhrasing = await Promise.all(
    phrasings.map(async (p) => {
      const [emb, kw] = await Promise.all([
        searchByEmbedding(p, filters, candidatesPerStage),
        searchByKeyword(p, filters, candidatesPerStage),
      ]);
      return { emb, kw };
    }),
  );
  const embedding_ms = Date.now() - tEmb0;
  const keyword_ms = Date.now() - tKw0;

  // Per-phrasing RRF merges, then folded into a single map by fact_id.
  // Folding sums rrf_scores across phrasings (RRF is additive over
  // independent rankings) so a fact hit by two phrasings beats a fact
  // hit by one, which is exactly what query expansion is supposed to
  // surface.
  const folded = new Map<string, MergeEntry>();
  let anyEmbeddingHit = false;
  let anyKeywordHit = false;
  for (const { emb, kw } of perPhrasing) {
    if (emb.length > 0) anyEmbeddingHit = true;
    if (kw.length > 0) anyKeywordHit = true;
    const merged = mergeRRF(emb, kw);
    for (const entry of merged) {
      const existing = folded.get(entry.fact.fact_id);
      if (existing) {
        existing.rrf_score += entry.rrf_score;
        for (const via of entry.matched_via) {
          if (!existing.matched_via.includes(via)) {
            existing.matched_via.push(via);
          }
        }
      } else {
        // Clone matched_via so subsequent dedup mutations don't bleed
        // back into the per-phrasing merge result.
        folded.set(entry.fact.fact_id, {
          fact: entry.fact,
          rrf_score: entry.rrf_score,
          matched_via: [...entry.matched_via],
        });
      }
    }
  }
  const merged = Array.from(folded.values()).sort(
    (a, b) => b.rrf_score - a.rrf_score,
  );

  return {
    candidates: merged,
    timing: { embedding_ms, keyword_ms },
    ran: {
      embedding: anyEmbeddingHit,
      keyword: anyKeywordHit,
    },
  };
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
 *
 * Composes expandQuery() (stage 0) + retrieveHybridStaged() (stages 1+2)
 * + applyRerank (stage 3).
 *
 * SMART-K3 note: rerank is fed the ORIGINAL query, not the expansions.
 * Expansions are a recall device — they pull more facts into the
 * candidate pool — but precision belongs to the actual AM question.
 * Mixing expansion phrasings into the rerank input would dilute the
 * cross-attention signal.
 */
export async function retrieveFactsHybrid(
  query: string,
  options: HybridRetrievalOptions = {},
): Promise<HybridRetrievalResult> {
  const topK = options.topK ?? 5;
  const skipRerank = options.skipRerank ?? false;
  const skipExpansion = options.skipExpansion ?? false;

  // Empty-query short-circuit BEFORE any I/O — keeps the contract that
  // `retrieveFactsHybrid("")` is a free no-op (no Haiku call, no SQL,
  // zero timing).
  if (!query || !query.trim()) {
    return {
      facts: [],
      timing: { embedding_ms: 0, keyword_ms: 0, rerank_ms: 0, total_ms: 0 },
      ran: { embedding: false, keyword: false, rerank: false },
      candidate_pool_size: 0,
    };
  }

  const t0 = Date.now();

  // SMART-K3 — query expansion stage. Generate 2-3 alternative phrasings
  // for the same fact under different vocabulary, then OR-search them
  // alongside the original. Soft-fails to [original] on any error so
  // Beam retrieval quality is never worse than pre-expansion.
  let phrasings: string[] = [query];
  if (!skipExpansion) {
    phrasings = await expandQuery(query);
  }
  // expandQuery returns [original, ...expansions]; pass only the
  // expansions (slice 1) to the staged helper since it always treats the
  // primary query as phrasings[0] internally.
  const expansions = phrasings.length > 1 ? phrasings.slice(1) : [];

  const staged = await retrieveHybridStaged(query, {
    customer_id: options.customer_id,
    topic_category: options.topic_category,
    topic_subcategory: options.topic_subcategory,
    field_name: options.field_name,
    value_numeric_gte: options.value_numeric_gte,
    value_numeric_lte: options.value_numeric_lte,
    // SMART-K2 — see filters block in retrieveHybridStaged.
    includeStale: options.includeStale,
    candidatesPerStage: options.candidatesPerStage,
    expansions,
  });

  const merged = staged.candidates;

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

  // SMART-K4 — derived_from auto-pull. For each fact in the top-K that
  // has a parent fact, fetch the parent (same-customer scope) and inject
  // it into the result so Beam never sees a derived child without the
  // parent context (e.g. owner_email cited but owner_info missing).
  //
  // Cap: result is bounded to topK * 2. The slice ordering preserves the
  // ranked top-K first, then appends parents in fact_id order. Parents
  // already in the top-K (same fact surfaced both directly + as someone
  // else's parent) are deduplicated by fact_id.
  scored = await expandWithParents(scored, topK);

  return {
    facts: scored,
    timing: {
      embedding_ms: staged.timing.embedding_ms,
      keyword_ms: staged.timing.keyword_ms,
      rerank_ms,
      total_ms: Date.now() - t0,
    },
    ran: {
      embedding: staged.ran.embedding,
      keyword: staged.ran.keyword,
      rerank: ranRerank,
    },
    candidate_pool_size: merged.length,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * SMART-K4 — derived_from auto-pull
 *
 * Beam often cites a derived fact (e.g. owner_email = "sarah@…") whose
 * parent fact (owner_info = "Sarah owns Pearl, decided to go with us in
 * Q2 2025…") carries the operational context. Without an explicit pull,
 * the parent never reaches the prompt and the reply loses grounding.
 *
 * For every top-K fact with derived_from set, we fetch the parent and
 * append it as a synthetic ScoredFact tagged matched_via=["derived_expansion"].
 * Same-customer scope is enforced — the parent fact's customer_id MUST
 * equal the child's; writeBrainFact rejects cross-customer links upfront,
 * but we re-check at read time in case the data ever drifts.
 *
 * Cap: bounded to topK * 2 to prevent runaway payloads on facts with
 * chained parents. Authoritative-only (superseded_by IS NULL,
 * soft_deleted_at IS NULL, sunset_at honored) — superseded parents are
 * intentionally skipped (if the parent itself was superseded the
 * derived child probably should be too; surfacing a stale parent would
 * mislead Beam more than dropping it).
 * ──────────────────────────────────────────────────────────────────────── */

export async function expandWithParents(
  scored: ScoredFact[],
  topK: number,
): Promise<ScoredFact[]> {
  if (scored.length === 0) return scored;

  const cap = topK * 2;
  if (scored.length >= cap) return scored; // already at or beyond cap, no room for parents

  // Collect unique parent fact_ids referenced by the top-K. Skip parents
  // that are already in the result (fact already self-cited).
  const present = new Set(scored.map((s) => s.fact.fact_id));
  const wantedParentIds = new Set<string>();
  for (const s of scored) {
    const parentId = s.fact.derived_from ?? null;
    if (!parentId) continue;
    if (present.has(parentId)) continue;
    wantedParentIds.add(parentId);
  }
  if (wantedParentIds.size === 0) return scored;

  const sql = getSql();
  if (!sql) return scored; // soft-fail when SQL not configured

  const parentIds = Array.from(wantedParentIds);
  // Pull parents in one round-trip. Scope strictly:
  //   - same customer_id as the child (defense in depth — writeBrainFact
  //     already rejects cross-customer, but reads shouldn't trust that)
  //   - authoritative (superseded_by IS NULL)
  //   - live (soft_deleted_at IS NULL, sunset honored)
  // The customer-id check is per-row in the WHERE clause; we pre-build
  // a child_customer_id map and filter post-fetch instead of building
  // SQL with a long OR chain.
  let parentRows: BrainFact[] = [];
  try {
    parentRows = (await sql`
      SELECT * FROM beacon_brain_facts
      WHERE fact_id = ANY(${parentIds}::uuid[])
        AND soft_deleted_at IS NULL
        AND (sunset_at IS NULL OR sunset_at > NOW())
        AND superseded_by IS NULL
    `) as BrainFact[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[retrieve] parent auto-pull threw: ${msg}`);
    return scored;
  }

  if (parentRows.length === 0) return scored;

  // Map fact_id → child's customer_id so we can confirm the parent is in
  // the same scope (skip any that drifted cross-customer).
  const childCustomerIdByParentId = new Map<string, string>();
  for (const s of scored) {
    const parentId = s.fact.derived_from ?? null;
    if (parentId) childCustomerIdByParentId.set(parentId, s.fact.customer_id);
  }

  const room = cap - scored.length;
  const additions: ScoredFact[] = [];
  for (const parent of parentRows) {
    if (additions.length >= room) break;
    const expectedCustomerId = childCustomerIdByParentId.get(parent.fact_id);
    if (!expectedCustomerId) continue;
    if (parent.customer_id !== expectedCustomerId) {
      // Drift detected — log and skip. Shouldn't happen given the write-
      // side validation, but defense in depth is cheap.
      console.warn(
        `[retrieve] derived_from cross-customer drift: parent ${parent.fact_id} customer_id=${parent.customer_id} differs from child's ${expectedCustomerId}; skipping`,
      );
      continue;
    }
    additions.push({
      fact: parent,
      // No RRF or rerank — the parent didn't participate in either stage.
      // Score is 0 (lower than any retrieved fact) so consumers ordering
      // by score know it's the "pulled context" tail. matched_via tells
      // them why it's there.
      rrf_score: 0,
      rerank_score: null,
      matched_via: ["derived_expansion"],
    });
  }

  return [...scored, ...additions];
}
