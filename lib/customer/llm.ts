/**
 * Thin Anthropic API wrapper with graceful fallback.
 *
 * - When ANTHROPIC_API_KEY is unset, every call short-circuits and returns
 *   the provided `fallback` string. Callers never see an error.
 * - When set, calls Claude Haiku via the Messages API with a 6s timeout.
 * - In-memory LRU cache keyed by sha256(prompt + system + model) for cheap
 *   re-renders within the same Node process.
 *
 * Cost shape (Haiku, claude-haiku-4-5-20251001):
 * - $0.80 / 1M input tokens, $4 / 1M output tokens
 * - Typical narrative call: ~600 input + 80 output tokens = ~$0.0008
 * - 922 customers × 1 narrative per day = ~$0.74/day = ~$22/month
 *
 * Caching cuts that further when content (signals, comms) is stable day-over-day.
 */

import { createHash } from "crypto";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

/** Bump when system prompts change so cached results invalidate. */
export const NARRATIVE_PROMPT_VERSION = "v3";

type CallOpts = {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

const cache = new Map<string, { value: string; expiresAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_MAX = 2000;

function cacheKey(opts: CallOpts): string {
  const h = createHash("sha256");
  h.update(HAIKU_MODEL);
  h.update("\0");
  h.update(NARRATIVE_PROMPT_VERSION);
  h.update("\0");
  h.update(opts.system || "");
  h.update("\0");
  h.update(opts.prompt);
  h.update("\0");
  h.update(String(opts.maxTokens || 200));
  return h.digest("hex");
}

function pruneCache() {
  if (cache.size <= CACHE_MAX) return;
  const cutoff = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt < cutoff) cache.delete(k);
    if (cache.size <= CACHE_MAX * 0.8) break;
  }
}

/**
 * Call Claude Haiku with a prompt. Returns `fallback` if ANTHROPIC_API_KEY
 * is unset, if the call times out, or if the API returns an error.
 *
 * The fallback path is the production hot path until the env var is set.
 */
export async function callHaiku(
  opts: CallOpts,
  fallback: string,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallback;

  const key = cacheKey(opts);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 6_000);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: opts.maxTokens ?? 200,
        temperature: opts.temperature ?? 0.3,
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      console.warn(`[llm] Haiku ${res.status}: ${text.slice(0, 200)} — using fallback`);
      return fallback;
    }
    const json = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const out = (json.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("")
      .trim();
    if (!out) return fallback;
    cache.set(key, { value: out, expiresAt: Date.now() + CACHE_TTL_MS });
    pruneCache();
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[llm] Haiku call failed: ${msg} — using fallback`);
    return fallback;
  }
}

/**
 * Parse a structured JSON response from Haiku with fallback.
 * Returns the parsed object or `fallback` if anything fails.
 */
export async function callHaikuJson<T>(
  opts: CallOpts,
  fallback: T,
): Promise<T> {
  const raw = await callHaiku(opts, "");
  if (!raw) return fallback;
  try {
    // Strip code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
}

export function llmConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
