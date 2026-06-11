/**
 * SMOKE-FIX 2 — per-turn bulk-action guard helper.
 *
 * Background: FIX E-16.C originally capped each /api/ai/ask turn at ONE
 * `tool_use` block to refuse "do X for these 5 customers" bulk actions.
 * That heuristic misfired on legitimate multi-tool-for-one-customer asks
 * (e.g. "how engaged are they in the app AND how are their reviews
 * trending?" → two reads against the SAME entity_id, both should fire).
 *
 * The new rule: count DISTINCT customers across this turn's tool calls.
 * Allow any number of calls if they all target the same entity_id /
 * customer_id; refuse only when calls span MULTIPLE customers.
 *
 * This module exports the small, pure function the route uses to extract
 * the customer scope from a tool_use input. Living in lib/ai/ keeps it
 * importable from vitest without dragging the route's NextAuth /
 * Anthropic / context-loader graph into the test.
 */

/**
 * Pull the customer scope out of a tool_use input. Tools across the
 * registry use either `entity_id`, `customer_id`, or `cb_customer_id`
 * as their primary customer arg; this normalizes them to a single string
 * when present. Tools without a customer arg (lookup_customer,
 * query_customer_book, query_brain, etc.) return null and are treated as
 * "scopeless" — the guard lets them fire freely.
 */
export function extractEntityIdFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  // Order matters only for clarity — exactly one of these should be set per
  // tool, but if multiple appear we treat the first non-empty as canonical.
  const candidates = ["entity_id", "customer_id", "cb_customer_id"] as const;
  for (const key of candidates) {
    const v = obj[key];
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

/**
 * Decide whether a tool_use about to be emitted on the SSE stream should
 * be allowed through the bulk-action guard.
 *
 * Inputs:
 *   - `seenEntityIds`: the set of distinct customer IDs already emitted
 *     this turn. Mutated by the caller after an allowed call.
 *   - `callEntityId`: the customer ID this call targets, or null for
 *     scopeless tools (lookup_customer / query_*).
 *
 * Returns `true` if the call should be emitted, `false` if the guard
 * should drop it (and surface the standard "one customer at a time"
 * refusal in the transcript).
 *
 * Rules:
 *   - Scopeless call → always allowed (returns true).
 *   - First scoped call this turn → allowed (returns true).
 *   - Subsequent scoped call targeting the SAME customer → allowed.
 *   - Subsequent scoped call targeting a DIFFERENT customer → blocked.
 */
export function shouldAllowToolUse(
  seenEntityIds: ReadonlySet<string>,
  callEntityId: string | null,
): boolean {
  if (!callEntityId) return true;
  if (seenEntityIds.size === 0) return true;
  return seenEntityIds.has(callEntityId);
}
