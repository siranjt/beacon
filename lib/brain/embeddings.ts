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
