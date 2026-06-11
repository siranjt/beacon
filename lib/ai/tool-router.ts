/**
 * Two-stage tool routing — SMART-B2.
 *
 * Before sending the question to Sonnet for the main answer turn, a cheap
 * Haiku call decides which 1-3 of the scope's whitelisted tools the question
 * actually needs. Sonnet then only sees that trimmed subset.
 *
 * Two wins:
 *   1. Token savings — each tool definition is ~300-600 input tokens
 *      (description + JSON schema). A customer-360 turn that today sends 13
 *      tools and only needs `read_customer_brain` is paying for 12 extra
 *      definitions. Trimming to the 2-3 the question needs is ~70% of the
 *      tool-block cost.
 *   2. Tool-choice quality — fewer near-miss candidates means Sonnet is
 *      less likely to reach for the wrong tool (e.g. calling
 *      `query_customer_book` when the user just asked about one customer).
 *
 * Safety model: every stage soft-fails to the full candidate set. If Haiku
 * errors, returns no JSON, returns a non-array, or names tools we don't
 * recognize, the caller falls back to sending all candidate tools to Sonnet.
 * The router is a pure optimization — it must never block or downgrade the
 * Beam quality floor.
 */

import { createHash } from "crypto";
import { callHaikuJson } from "@/lib/customer/llm";
import type { AiScope } from "@/lib/ai/scopes";
import type { BeaconTool } from "@/lib/ai/tools";

/** Max tools the router is allowed to forward to Sonnet. */
const MAX_ROUTED_TOOLS = 3;

/** Minimum question length below which routing is skipped. */
const MIN_QUESTION_CHARS = 5;

/** Cache TTL — short-lived. Most users won't repeat the exact question. */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** Hard cap on the cache so we don't grow unbounded in long-lived processes. */
const CACHE_MAX = 500;

/**
 * In-memory routing cache. Key = sha256(question + scopeKey + candidate
 * tool-name signature). Value = the tool-name allowlist Haiku picked.
 *
 * Module-scoped so it survives across requests in the same warm Lambda
 * invocation; resets on cold start (acceptable — Haiku call is cheap).
 */
const cache = new Map<string, { tools: string[]; expiresAt: number }>();

function pruneCache(): void {
  if (cache.size <= CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt < now) cache.delete(k);
    if (cache.size <= CACHE_MAX * 0.8) break;
  }
}

/**
 * Returns true if the question is too short/empty to benefit from
 * Haiku-driven routing. Defensive against client junk + tool-continuation
 * messages (which are model→model, not user-question and don't need
 * re-routing — the continuation already knows which tool was used).
 */
function isQuestionRoutable(q: string): boolean {
  if (q.length < MIN_QUESTION_CHARS) return false;
  // Tool-continuation messages (synthetic follow-ups carrying tool output)
  // should NOT be re-routed — they're a transcript artifact, not a new ask.
  if (q.startsWith("[Beacon ran ") || q.startsWith("[Beacon's ")) return false;
  return true;
}

/**
 * Strip a BeaconTool's multi-line description down to a single one-liner
 * suitable for the Haiku prompt. Most tool descriptions start with a verb
 * phrase on line 1 before drilling into args/examples on later lines.
 */
function toOneLiner(description: string): string {
  const firstLine = description.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

/**
 * Build the cache key. Scope is folded in because the same question on
 * different scopes can route to different tools.
 */
function buildCacheKey(
  scopeKindLabel: string,
  question: string,
  candidates: BeaconTool[],
): string {
  const h = createHash("sha256");
  h.update(scopeKindLabel);
  h.update("\0");
  h.update(question);
  h.update("\0");
  // Tool-name signature so a registry change invalidates the cache.
  h.update(candidates.map((t) => t.name).sort().join(","));
  return h.digest("hex");
}

/**
 * Parse a Haiku response into a clean list of tool names. Accepts:
 *   - Raw JSON array of strings: ["a", "b"]
 *   - JSON object with a `tools` key: {"tools": ["a", "b"]}
 *   - Whitespace + code fences are already stripped by callHaikuJson.
 *
 * Anything else returns [] (caller treats as "no routing decision" and
 * falls back to the full candidate set).
 */
function extractToolNames(parsed: unknown): string[] {
  if (Array.isArray(parsed)) {
    return parsed.filter((x): x is string => typeof x === "string");
  }
  if (parsed && typeof parsed === "object" && "tools" in parsed) {
    const t = (parsed as { tools: unknown }).tools;
    if (Array.isArray(t)) {
      return t.filter((x): x is string => typeof x === "string");
    }
  }
  return [];
}

/**
 * Filter the candidate tool list down to the ones Haiku named (intersect
 * with valid tools, cap at MAX_ROUTED_TOOLS, dedupe).
 */
export function filterCandidatesByNames(
  candidates: BeaconTool[],
  names: string[],
): BeaconTool[] {
  const wanted = new Set(names);
  const seen = new Set<string>();
  const out: BeaconTool[] = [];
  for (const t of candidates) {
    if (!wanted.has(t.name)) continue;
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push(t);
    if (out.length >= MAX_ROUTED_TOOLS) break;
  }
  return out;
}

/**
 * Build the Haiku routing prompt. Compact on purpose — the whole point is
 * to spend a small number of Haiku tokens to save a much larger number of
 * Sonnet tokens. Keep the candidate list to one-liners.
 */
export function buildRoutingPrompt(
  question: string,
  candidates: BeaconTool[],
): string {
  const lines = candidates.map((t) => `- ${t.name}: ${toOneLiner(t.description)}`);
  return [
    `User question: "${question}"`,
    "",
    "Available tools (name + one-line purpose):",
    ...lines,
    "",
    `Reply with a JSON array of 1-${MAX_ROUTED_TOOLS} tool names this question actually needs.`,
    "If unsure, include the most likely tool. Output only JSON: [\"a\", \"b\"]",
  ].join("\n");
}

const ROUTING_SYSTEM_PROMPT =
  "You are a tool router for the Beam copilot. Pick the smallest set of tools (1-3) that the question genuinely needs. Output only a JSON array of tool names from the provided list. No prose, no markdown, no explanation.";

/** Outcome of a routing call — useful for activity-log metadata. */
export interface RoutingDecision {
  /** The candidate set actually forwarded to Sonnet. */
  tools: BeaconTool[];
  /** Tool names Haiku picked (post-filter, post-cap). */
  pickedNames: string[];
  /** Total candidates seen by the router (size of input set). */
  candidateCount: number;
  /** Whether routing was applied or skipped entirely. */
  routed: boolean;
  /** Reason routing was skipped, if it was. */
  skipReason?: string;
  /** Whether the response came from the in-memory cache. */
  cacheHit: boolean;
}

/**
 * Returns true when routing should be skipped entirely. Callers should
 * forward the full candidate set in that case.
 *
 * Skip cases:
 *   - `BEAM_TOOL_ROUTING_DISABLED=true` env flag
 *   - Empty/very short question
 *   - Tool-continuation message (synthetic follow-up)
 *   - Candidate set has 3 or fewer tools (no savings possible —
 *     Haiku call would cost more than the tokens it saves)
 */
export function shouldSkipRouting(
  question: string,
  candidates: BeaconTool[],
): { skip: true; reason: string } | { skip: false } {
  if (process.env.BEAM_TOOL_ROUTING_DISABLED === "true") {
    return { skip: true, reason: "env_disabled" };
  }
  if (!isQuestionRoutable(question)) {
    return { skip: true, reason: "question_not_routable" };
  }
  if (candidates.length <= MAX_ROUTED_TOOLS) {
    return { skip: true, reason: "candidate_set_already_small" };
  }
  return { skip: false };
}

/**
 * Ask Haiku which of the scope's whitelisted tools the question needs.
 * Returns a routing decision the caller can use both to trim the tool
 * payload sent to Sonnet AND to log what the router picked.
 *
 * Soft-fail behavior: any stage that fails (env unset, Haiku error, bad
 * JSON, empty intersection) returns the FULL candidate set so the main
 * Sonnet turn never regresses on tool availability.
 */
export async function routeTools(
  scope: AiScope,
  question: string,
  candidates: BeaconTool[],
): Promise<RoutingDecision> {
  const skip = shouldSkipRouting(question, candidates);
  if (skip.skip) {
    return {
      tools: candidates,
      pickedNames: candidates.map((t) => t.name),
      candidateCount: candidates.length,
      routed: false,
      skipReason: skip.reason,
      cacheHit: false,
    };
  }

  const cacheKey = buildCacheKey(scope.kind, question, candidates);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const filtered = filterCandidatesByNames(candidates, cached.tools);
    if (filtered.length > 0) {
      return {
        tools: filtered,
        pickedNames: filtered.map((t) => t.name),
        candidateCount: candidates.length,
        routed: true,
        cacheHit: true,
      };
    }
    // Cached set no longer maps to known tools — invalidate + re-route.
    cache.delete(cacheKey);
  }

  // Ask Haiku. callHaikuJson handles fences + JSON.parse + soft-fails to
  // the fallback we pass below (empty array → we treat as "no decision").
  let pickedNames: string[] = [];
  try {
    const parsed = await callHaikuJson<unknown>(
      {
        system: ROUTING_SYSTEM_PROMPT,
        prompt: buildRoutingPrompt(question, candidates),
        maxTokens: 100,
        temperature: 0,
        timeoutMs: 3_000,
      },
      [],
    );
    pickedNames = extractToolNames(parsed);
  } catch {
    // callHaikuJson already soft-fails internally; this catch is belt-and-
    // suspenders for any unexpected throw shape.
    pickedNames = [];
  }

  const filtered = filterCandidatesByNames(candidates, pickedNames);
  if (filtered.length === 0) {
    // No valid routing decision — fall back to the full candidate set.
    return {
      tools: candidates,
      pickedNames: candidates.map((t) => t.name),
      candidateCount: candidates.length,
      routed: false,
      skipReason: "haiku_no_decision",
      cacheHit: false,
    };
  }

  cache.set(cacheKey, {
    tools: filtered.map((t) => t.name),
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  pruneCache();

  return {
    tools: filtered,
    pickedNames: filtered.map((t) => t.name),
    candidateCount: candidates.length,
    routed: true,
    cacheHit: false,
  };
}

/** Test hook — clear the routing cache. Not for production use. */
export function _clearRoutingCacheForTest(): void {
  cache.clear();
}
