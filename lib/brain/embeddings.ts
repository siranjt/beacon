/**
 * Wave 2b — Voyage AI embeddings client for the Keeper.
 *
 * Each fact gets embedded by concatenating its semantic context:
 *   `${topic_subcategory}/${field_name}: ${value}`
 *
 * Stored in beacon_brain_facts.embedding (vector(1024) via pgvector).
 * Cosine similarity then catches near-duplicates that exact-string match
 * misses — e.g., "Service Partner has requested to churn" vs "SP has
 * requested to cancel". Threshold is 0.92 by default (tunable via env).
 *
 * Vendor choice: Voyage's voyage-3-lite is 1024-dim, ~$0.02/M tokens,
 * recommended by Anthropic for semantic search. Self-hosting isn't worth
 * the operational complexity at our scale.
 *
 * Soft-fail philosophy: if VOYAGE_API_KEY is unset OR the API call
 * fails, we skip the embedding (column stays NULL) and skip the conflict
 * check. The write still lands. Better to ship an un-dedup'd fact than
 * to block on a flaky dependency.
 */

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const VOYAGE_MODEL = process.env.VOYAGE_MODEL || "voyage-3-lite";
// Wave-1 (hybrid retrieval): rerank-2.5-lite is the cheap variant
// (~$0.05/1K queries). top-k 50 candidates → top-5 final is well inside
// its 1K-doc context window and is the standard precision lift on top of
// raw cosine. Tune model via env if needed.
const VOYAGE_RERANK_MODEL =
  process.env.VOYAGE_RERANK_MODEL || "rerank-2.5-lite";
const EMBEDDING_DIM = 1024;

/**
 * Cosine threshold above which two facts are treated as semantic
 * duplicates. 0.92 chosen empirically — voyage-3-lite returns ~0.95+ for
 * paraphrases of the same fact and ~0.7-0.85 for related-but-distinct.
 *
 * Tune via env if false-positive rate is high during early use.
 */
export const SEMANTIC_DUPLICATE_THRESHOLD = Number(
  process.env.W2B_DUP_THRESHOLD || 0.92,
);

export interface EmbeddingResult {
  embedding: number[];
  input_tokens: number;
  model: string;
}

/**
 * Compose the text to embed from a fact's classification + value.
 * Including the subcategory + field name in the embedded text means
 * "preferred channel: WhatsApp" lands close to "comms preference:
 * WhatsApp" and far from "platform: WhatsApp" — exactly what we want.
 */
export function factEmbeddingText(
  topic_subcategory: string,
  field_name: string,
  value: string,
): string {
  // Compact, semantic-rich form. Spaces matter for the tokenizer.
  return `${topic_subcategory} / ${field_name}: ${value}`;
}

/**
 * Embed a single string via Voyage. Returns null on any failure
 * (missing key, network error, malformed response). Caller must
 * tolerate null.
 */
export async function embedText(text: string): Promise<EmbeddingResult | null> {
  if (!VOYAGE_API_KEY) return null;
  if (!text || !text.trim()) return null;
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        input: [text],
        model: VOYAGE_MODEL,
        input_type: "document",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[embeddings] Voyage ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
      usage?: { total_tokens?: number };
    };
    const vec = json.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
      console.warn(
        `[embeddings] Voyage returned wrong shape: ${Array.isArray(vec) ? vec.length : typeof vec}`,
      );
      return null;
    }
    return {
      embedding: vec,
      input_tokens: json.usage?.total_tokens ?? 0,
      model: VOYAGE_MODEL,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[embeddings] Voyage call threw: ${msg}`);
    return null;
  }
}

/**
 * Wave-1 (hybrid retrieval) — embed a search query.
 *
 * Voyage's asymmetric retrieval recommends `input_type: "query"` for the
 * search side and `input_type: "document"` for the stored side. Same
 * model, different input_type — Voyage applies a model-side prefix that
 * lifts retrieval quality vs. using document-mode for both.
 *
 * Returns null on any failure (matches embedText's soft-fail pattern).
 * Caller must tolerate null — fall back to keyword-only retrieval.
 */
export async function embedQuery(text: string): Promise<EmbeddingResult | null> {
  if (!VOYAGE_API_KEY) return null;
  if (!text || !text.trim()) return null;
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        input: [text],
        model: VOYAGE_MODEL,
        input_type: "query",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(
        `[embeddings] Voyage query ${res.status}: ${body.slice(0, 200)}`,
      );
      return null;
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
      usage?: { total_tokens?: number };
    };
    const vec = json.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
      console.warn(
        `[embeddings] Voyage query returned wrong shape: ${
          Array.isArray(vec) ? vec.length : typeof vec
        }`,
      );
      return null;
    }
    return {
      embedding: vec,
      input_tokens: json.usage?.total_tokens ?? 0,
      model: VOYAGE_MODEL,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[embeddings] Voyage query threw: ${msg}`);
    return null;
  }
}

/**
 * Wave-1 (hybrid retrieval) — rerank a candidate set against a query.
 *
 * Pipeline position: after the hybrid (embedding ∪ BM25) merge stage
 * produces ~50 candidates, we hand them to rerank-2.5-lite to pick the
 * top-K with cross-attention scoring. This catches the cases where
 * cosine + keyword both agree on something semantically close but
 * substantively wrong (e.g., "owner prefers SMS" vs "owner prefers
 * email" cosines very high; rerank catches the polarity flip).
 *
 * Returns the reranked indices + relevance scores, OR null on any
 * failure. Caller must tolerate null and fall back to the input
 * ordering. Indices are 0-based against the input `documents` array.
 *
 * Cost: ~$0.05 per 1K queries (rerank-2.5-lite). Each call counts as
 * 1 query regardless of candidate count (up to 1000 docs).
 */
export interface RerankResult {
  /** Index into the original `documents` array passed in. */
  index: number;
  /** Voyage's relevance score, 0-1. Higher = more relevant. */
  relevance_score: number;
}

export async function rerankDocuments(
  query: string,
  documents: string[],
  options?: { topK?: number; model?: string },
): Promise<RerankResult[] | null> {
  if (!VOYAGE_API_KEY) return null;
  if (!query || !query.trim()) return null;
  if (!documents.length) return [];

  const topK = options?.topK ?? Math.min(5, documents.length);
  const model = options?.model || VOYAGE_RERANK_MODEL;

  try {
    const res = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        documents,
        model,
        top_k: topK,
        // We already have the documents locally — no need to ship them
        // back over the wire. Cuts response size dramatically.
        return_documents: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[embeddings] Voyage rerank ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as {
      data?: Array<{ index?: number; relevance_score?: number }>;
    };
    const data = json.data;
    if (!Array.isArray(data)) {
      console.warn(`[embeddings] Voyage rerank returned no data array`);
      return null;
    }
    const out: RerankResult[] = [];
    for (const row of data) {
      if (
        typeof row.index === "number" &&
        typeof row.relevance_score === "number" &&
        row.index >= 0 &&
        row.index < documents.length
      ) {
        out.push({ index: row.index, relevance_score: row.relevance_score });
      }
    }
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[embeddings] Voyage rerank threw: ${msg}`);
    return null;
  }
}

/**
 * Batched variant — embeds multiple texts in one API call. Used by the
 * backfill cron to amortize HTTP overhead across the 1,269 existing
 * candidates.
 *
 * Voyage's batch limit is 128 inputs per call. We chunk above that.
 */
export async function embedTextsBatch(
  texts: string[],
): Promise<(number[] | null)[]> {
  if (!VOYAGE_API_KEY) return texts.map(() => null);
  if (texts.length === 0) return [];

  const BATCH_SIZE = 128;
  const out: (number[] | null)[] = new Array(texts.length).fill(null);

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const slice = texts.slice(start, start + BATCH_SIZE);
    const nonEmptyIndices = slice
      .map((t, i) => (t && t.trim() ? i : -1))
      .filter((i) => i !== -1);
    if (nonEmptyIndices.length === 0) continue;
    const inputs = nonEmptyIndices.map((i) => slice[i]);
    try {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VOYAGE_API_KEY}`,
        },
        body: JSON.stringify({
          input: inputs,
          model: VOYAGE_MODEL,
          input_type: "document",
        }),
      });
      if (!res.ok) {
        console.warn(`[embeddings] Voyage batch ${res.status}`);
        continue;
      }
      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const vectors = json.data ?? [];
      for (let i = 0; i < nonEmptyIndices.length; i++) {
        const idx = start + nonEmptyIndices[i];
        const vec = vectors[i]?.embedding;
        if (Array.isArray(vec) && vec.length === EMBEDDING_DIM) {
          out[idx] = vec;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[embeddings] Voyage batch threw: ${msg}`);
    }
  }

  return out;
}

/**
 * Format a number[] as a pgvector literal string. Used to bind embedding
 * values in template-string SQL queries (the Neon serverless driver
 * doesn't bind array params directly for vector type).
 *
 *   [0.1, 0.2, 0.3] → "[0.1,0.2,0.3]"
 */
export function formatVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
