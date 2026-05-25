/**
 * Beacon AI memory layer. Phase E-9.
 *
 * Read/write helpers over the beacon_ai_conversations Postgres table.
 * Persists every user ↔ Beacon turn so the copilot has continuity across
 * sessions, devices, and surfaces. Beacon "evolves" by accumulating this
 * conversation history and weaving recent turns into its system prompt
 * on every new question.
 *
 * Note: this is NOT model fine-tuning. The Anthropic model weights are
 * unchanged. What evolves is the prompt-time context per user.
 *
 * All functions are defensive against `getSql() === null` (no
 * POSTGRES_URL configured) — they silently no-op rather than crashing
 * Beacon when storage isn't wired.
 */

import { getSql } from "@/lib/customer/postgres";

/** Maximum characters per turn — defensively truncate to keep the prompt
 *  manageable. Most Beacon responses are well under 4 KB; 8 KB cap is
 *  generous and matches the per-question limit on the front end. */
const MAX_CONTENT_CHARS = 8000;

export interface PersistedTurn {
  id: number;
  email: string;
  scope_key: string;
  role: "user" | "assistant";
  content: string;
  metadata: Record<string, unknown> | null;
  ts: string;
}

/**
 * Write a single turn. Returns the inserted row id when storage is wired,
 * or null when no DB is available / the write failed. Phase E-12 — callers
 * (the ask route) use the assistant-turn id as the feedback target.
 *
 * Failures never throw — Beacon AI chat should keep working even when the
 * Postgres write fails.
 */
export async function saveTurn(input: {
  email: string;
  scope_key: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown> | null;
}): Promise<number | null> {
  try {
    const sql = getSql();
    if (!sql) return null;
    const content =
      input.content.length > MAX_CONTENT_CHARS
        ? input.content.slice(0, MAX_CONTENT_CHARS)
        : input.content;
    const meta = input.metadata ? JSON.stringify(input.metadata) : null;
    const rows = await sql`
      INSERT INTO beacon_ai_conversations (email, scope_key, role, content, metadata)
      VALUES (${input.email}, ${input.scope_key}, ${input.role}, ${content}, ${meta}::jsonb)
      RETURNING id
    `;
    const r = (rows as unknown as Array<{ id: number }>)[0];
    return r?.id ?? null;
  } catch (err) {
    // Logging failures should never affect the user's chat session.
    console.warn(
      "[ai/memory.saveTurn] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Most recent turns from the CURRENT scope only (e.g. this customer's 360
 *  history). Used to hydrate the panel transcript when it opens, and as
 *  per-scope continuity context in the system prompt.
 */
export async function getScopeConversations(
  email: string,
  scope_key: string,
  limit: number = 30,
): Promise<PersistedTurn[]> {
  try {
    const sql = getSql();
    if (!sql) return [];
    const rows = await sql`
      SELECT id, email, scope_key, role, content, metadata, ts::text AS ts
        FROM beacon_ai_conversations
       WHERE email = ${email}
         AND scope_key = ${scope_key}
       ORDER BY ts DESC
       LIMIT ${limit}
    `;
    // Reverse for chronological order (oldest first).
    return (rows as unknown as PersistedTurn[]).reverse();
  } catch (err) {
    console.warn(
      "[ai/memory.getScopeConversations] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/** Most recent turns across ALL scopes (cross-scope timeline). Used to give
 *  Beacon a sense of "what has this user been talking about lately" so it
 *  can naturally reference past topics regardless of which page the user
 *  is on right now.
 *
 *  Excludes the current scope by default — caller already has scope
 *  history via getScopeConversations() and doesn't want duplication.
 */
export async function getRecentCrossScope(
  email: string,
  excludeScopeKey: string | null,
  limit: number = 20,
): Promise<PersistedTurn[]> {
  try {
    const sql = getSql();
    if (!sql) return [];
    const rows = excludeScopeKey
      ? await sql`
          SELECT id, email, scope_key, role, content, metadata, ts::text AS ts
            FROM beacon_ai_conversations
           WHERE email = ${email}
             AND scope_key <> ${excludeScopeKey}
           ORDER BY ts DESC
           LIMIT ${limit}
        `
      : await sql`
          SELECT id, email, scope_key, role, content, metadata, ts::text AS ts
            FROM beacon_ai_conversations
           WHERE email = ${email}
           ORDER BY ts DESC
           LIMIT ${limit}
        `;
    return (rows as unknown as PersistedTurn[]).reverse();
  } catch (err) {
    console.warn(
      "[ai/memory.getRecentCrossScope] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/** Total conversations stored for this user. Used by the panel header
 *  ("Beacon remembers N conversations"). */
export async function countConversationsForUser(
  email: string,
): Promise<number> {
  try {
    const sql = getSql();
    if (!sql) return 0;
    const rows = await sql`
      SELECT COUNT(DISTINCT ts::date)::int AS n
        FROM beacon_ai_conversations
       WHERE email = ${email}
    `;
    const r = (rows as unknown as Array<{ n: number }>)[0];
    return r?.n ?? 0;
  } catch (err) {
    console.warn(
      "[ai/memory.countConversationsForUser] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

/** Distinct scopes the user has talked to Beacon in. Useful for surfacing
 *  cross-scope chips in the UI ("you've also discussed X about this
 *  customer in the post-payment scope"). */
export async function listScopesForUser(
  email: string,
): Promise<Array<{ scope_key: string; turn_count: number; last_ts: string }>> {
  try {
    const sql = getSql();
    if (!sql) return [];
    const rows = await sql`
      SELECT scope_key,
             COUNT(*)::int AS turn_count,
             MAX(ts)::text AS last_ts
        FROM beacon_ai_conversations
       WHERE email = ${email}
       GROUP BY scope_key
       ORDER BY last_ts DESC
       LIMIT 40
    `;
    return rows as unknown as Array<{
      scope_key: string;
      turn_count: number;
      last_ts: string;
    }>;
  } catch (err) {
    console.warn(
      "[ai/memory.listScopesForUser] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/** Wipe ALL Beacon AI memory for a user — used by the "Clear history"
 *  control in the AskPanel drawer. Returns the count of deleted rows. */
export async function clearUserMemory(email: string): Promise<number> {
  try {
    const sql = getSql();
    if (!sql) return 0;
    const rows = await sql`
      DELETE FROM beacon_ai_conversations
       WHERE email = ${email}
       RETURNING id
    `;
    return (rows as unknown as unknown[]).length;
  } catch (err) {
    console.warn(
      "[ai/memory.clearUserMemory] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

/** Wipe only the current scope's history (e.g. "clear this customer's
 *  conversation but keep my other scopes intact"). */
export async function clearScopeMemory(
  email: string,
  scope_key: string,
): Promise<number> {
  try {
    const sql = getSql();
    if (!sql) return 0;
    const rows = await sql`
      DELETE FROM beacon_ai_conversations
       WHERE email = ${email}
         AND scope_key = ${scope_key}
       RETURNING id
    `;
    return (rows as unknown as unknown[]).length;
  } catch (err) {
    console.warn(
      "[ai/memory.clearScopeMemory] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

/**
 * Format a small set of past turns as plain-text history blocks for the
 * system prompt. Truncates each turn's content + caps total characters.
 *
 * Output shape:
 *   ## RECENT CROSS-SCOPE MEMORY
 *   (last N turns, oldest first)
 *
 *   [scope:customer-360:abc] you · 2026-05-20: "Why is SkinSpa NYC RED?"
 *   [scope:customer-360:abc] Beacon: "Their composite is 78 because…"
 *   ...
 */
export function renderMemoryForPrompt(
  scopeHistory: PersistedTurn[],
  crossScope: PersistedTurn[],
  opts: { maxCharsPerTurn?: number; maxTurnsCrossScope?: number } = {},
): { scopeBlock: string; crossScopeBlock: string } {
  const maxChars = opts.maxCharsPerTurn ?? 400;
  const maxCross = opts.maxTurnsCrossScope ?? 14;

  const renderTurn = (t: PersistedTurn, withScope: boolean): string => {
    const day = t.ts.slice(0, 10);
    const speaker = t.role === "user" ? "you" : "Beacon";
    const tail =
      t.content.length > maxChars
        ? t.content.slice(0, maxChars) + "…"
        : t.content;
    const scope = withScope ? ` [scope:${t.scope_key}]` : "";
    return `${day} ${speaker}${scope}: ${tail}`;
  };

  const scopeBlock =
    scopeHistory.length > 0
      ? scopeHistory.map((t) => renderTurn(t, false)).join("\n")
      : "(no prior conversations on this surface)";

  const crossSlice = crossScope.slice(-maxCross);
  const crossScopeBlock =
    crossSlice.length > 0
      ? crossSlice.map((t) => renderTurn(t, true)).join("\n")
      : "(no recent conversations on other surfaces)";

  return { scopeBlock, crossScopeBlock };
}
