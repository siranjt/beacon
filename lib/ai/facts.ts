/**
 * Beacon AI distilled-fact memory. Phase E-9 Evolving Beacon · Phase 2.
 *
 * Layer ABOVE raw conversation turns: stable distilled facts per user,
 * sourced from either:
 *   1. "/remember X" slash command (explicit, confidence 1.00)
 *   2. Periodic Haiku extraction cron over the last 7 days of
 *      conversations (extracted, confidence 0.85 → 1.00 as re-encountered)
 *
 * Facts get injected into the Beacon AI system prompt's "USER PROFILE"
 * section so the assistant personalizes naturally without re-reading the
 * full conversation history every time.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getSql } from "@/lib/customer/postgres";
import { getRecentCrossScope } from "./memory";

/**
 * Phase E-12 — expanded category taxonomy.
 *   "style"      — preferred response length, format (bullets/prose), structure
 *   "tone"       — terse / warm / formal / friendly
 *   "depth"      — just-the-answer / reasoning included / explore options
 *   "onboarding" — captured from the first-login style questionnaire
 *
 * The original four (preference / context / behavior / explicit) remain so
 * existing data and the existing extraction prompt keep working — but the
 * sharpened extraction prompt below now emits style/tone/depth as first-class
 * categories instead of folding them into the generic "preference" bucket.
 */
export type FactCategory =
  | "preference"
  | "context"
  | "behavior"
  | "explicit"
  | "style"
  | "tone"
  | "depth"
  | "onboarding"
  | null;

export type FactSource = "extracted" | "explicit" | "onboarding" | "feedback";

export interface UserFact {
  id: number;
  email: string;
  fact: string;
  category: FactCategory;
  source: FactSource;
  confidence: number;
  created_at: string;
  last_seen_at: string;
  reference_count: number;
  active: boolean;
  /**
   * Phase E-12 — surface scope. NULL = global (applies on every surface).
   * Otherwise matches a scope_key like "customer-360:{entity_id}" or
   * "inbox" so style preferences can vary per surface.
   */
  scope_key?: string | null;
}

const MAX_FACT_CHARS = 280;
const EXTRACTION_MODEL =
  process.env.ANTHROPIC_FACT_MODEL ?? "claude-haiku-4-5-20251001";
const EXTRACTION_MAX_TOKENS = 1500;
const EXTRACTION_MIN_TURNS = 6; // Don't burn tokens on thin context.
const EXTRACTION_WINDOW_DAYS = 7;
const MAX_FACTS_PER_USER = 40; // Cap to keep prompts manageable.

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

/**
 * All facts for one user.
 *
 * Phase E-12 — supports surface-aware retrieval. When `scopeKey` is provided,
 * returns facts where `scope_key IS NULL` (global) OR `scope_key = ${scopeKey}`
 * (surface-specific). When `scopeKey` is omitted, falls back to legacy behavior:
 * all of the user's active facts regardless of scope. The settings page passes
 * no scope (it shows everything); the ask endpoint passes the current scope so
 * the system prompt only sees facts relevant to where the user is.
 */
export async function listFactsForUser(
  email: string,
  opts: { includeInactive?: boolean; scopeKey?: string | null } = {},
): Promise<UserFact[]> {
  try {
    const sql = getSql();
    if (!sql) return [];
    const { includeInactive = false, scopeKey } = opts;

    let rows: unknown;
    if (includeInactive) {
      // Settings UI — show everything, including inactive facts (deactivated
      // via thumbs-down or explicit user delete). No scope filter here.
      rows = await sql`
        SELECT id, email, fact, category, source,
               confidence::float AS confidence,
               created_at::text AS created_at,
               last_seen_at::text AS last_seen_at,
               reference_count, active, scope_key
          FROM beacon_ai_user_facts
         WHERE email = ${email}
         ORDER BY active DESC, last_seen_at DESC
         LIMIT 200
      `;
    } else if (typeof scopeKey === "string") {
      // Hot prompt-build path — surface-aware retrieval. Global facts
      // (scope_key IS NULL) always apply; surface-specific facts apply only
      // when their scope_key matches the current surface.
      rows = await sql`
        SELECT id, email, fact, category, source,
               confidence::float AS confidence,
               created_at::text AS created_at,
               last_seen_at::text AS last_seen_at,
               reference_count, active, scope_key
          FROM beacon_ai_user_facts
         WHERE email = ${email}
           AND active = TRUE
           AND (scope_key IS NULL OR scope_key = ${scopeKey})
         ORDER BY last_seen_at DESC
         LIMIT ${MAX_FACTS_PER_USER}
      `;
    } else {
      // Legacy path — all active facts regardless of scope (used by /facts API).
      rows = await sql`
        SELECT id, email, fact, category, source,
               confidence::float AS confidence,
               created_at::text AS created_at,
               last_seen_at::text AS last_seen_at,
               reference_count, active, scope_key
          FROM beacon_ai_user_facts
         WHERE email = ${email}
           AND active = TRUE
         ORDER BY last_seen_at DESC
         LIMIT ${MAX_FACTS_PER_USER}
      `;
    }
    return rows as unknown as UserFact[];
  } catch (err) {
    console.warn(
      "[ai/facts.listFactsForUser] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Add an explicit/onboarding fact. Phase E-12 extended:
 *   - `category` defaults to "explicit" (backward-compatible /remember path).
 *     Pass "style"/"tone"/"depth"/"onboarding" from the onboarding flow.
 *   - `source` defaults to "explicit"; onboarding flow passes "onboarding".
 *   - `scopeKey` defaults to null (global). Surface-specific facts pass
 *     a scope_key like "customer-360" so they only fire on that surface.
 *
 * Deduplicates by (email, lowercase fact text, scope_key). If a duplicate
 * exists, refreshes last_seen_at + bumps reference_count instead of inserting.
 */
export async function addExplicitFact(input: {
  email: string;
  fact: string;
  category?: FactCategory;
  source?: FactSource;
  scopeKey?: string | null;
}): Promise<{ id: number; reused: boolean } | null> {
  try {
    const sql = getSql();
    if (!sql) return null;
    const fact = input.fact.trim().slice(0, MAX_FACT_CHARS);
    if (!fact) return null;
    const category = input.category ?? "explicit";
    const source = input.source ?? "explicit";
    const scopeKey = input.scopeKey ?? null;

    // Dedup check — scope_key participates in the uniqueness identity so a
    // user can have "Wants brief responses" globally and "Wants exhaustive
    // responses" on customer-360 without collision.
    const existing = scopeKey
      ? await sql`
          SELECT id FROM beacon_ai_user_facts
           WHERE email = ${input.email}
             AND LOWER(fact) = LOWER(${fact})
             AND scope_key = ${scopeKey}
             AND active = TRUE
           LIMIT 1
        `
      : await sql`
          SELECT id FROM beacon_ai_user_facts
           WHERE email = ${input.email}
             AND LOWER(fact) = LOWER(${fact})
             AND scope_key IS NULL
             AND active = TRUE
           LIMIT 1
        `;
    const rows = existing as unknown as Array<{ id: number }>;
    if (rows.length > 0) {
      await sql`
        UPDATE beacon_ai_user_facts
           SET last_seen_at = NOW(),
               reference_count = reference_count + 1
         WHERE id = ${rows[0].id}
      `;
      return { id: rows[0].id, reused: true };
    }

    const inserted = await sql`
      INSERT INTO beacon_ai_user_facts
        (email, fact, category, source, confidence, scope_key)
      VALUES
        (${input.email}, ${fact}, ${category}, ${source}, 1.00, ${scopeKey})
      RETURNING id
    `;
    const r = (inserted as unknown as Array<{ id: number }>)[0];
    return r ? { id: r.id, reused: false } : null;
  } catch (err) {
    console.warn(
      "[ai/facts.addExplicitFact] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Phase E-12 (E-12.3) — feedback-driven fact confidence adjustment.
 *
 * On thumbs-up: bump confidence on each fact by +0.05 (capped at 1.00) +
 * refresh last_seen_at. Models a positive reinforcement signal.
 *
 * On thumbs-down: decrement by 0.15. If confidence drops below 0.30, also
 * mark the fact inactive — strong negative signals should evict facts, not
 * just demote. (0.85 is the default extracted-fact confidence, so ~3-4
 * thumbs-down events evicts an extracted fact; explicit facts at 1.00 take
 * ~5 thumbs-down to evict.)
 *
 * Returns the number of facts adjusted so the caller can log it.
 */
export async function adjustFactConfidence(
  email: string,
  factIds: number[],
  signal: "up" | "down",
): Promise<number> {
  if (factIds.length === 0) return 0;
  try {
    const sql = getSql();
    if (!sql) return 0;
    if (signal === "up") {
      const rows = await sql`
        UPDATE beacon_ai_user_facts
           SET confidence = LEAST(1.00, confidence + 0.05),
               last_seen_at = NOW(),
               reference_count = reference_count + 1
         WHERE email = ${email}
           AND id = ANY(${factIds}::bigint[])
         RETURNING id
      `;
      return (rows as unknown as unknown[]).length;
    } else {
      const rows = await sql`
        UPDATE beacon_ai_user_facts
           SET confidence = GREATEST(0, confidence - 0.15),
               active = CASE WHEN confidence - 0.15 < 0.30 THEN FALSE ELSE active END
         WHERE email = ${email}
           AND id = ANY(${factIds}::bigint[])
         RETURNING id
      `;
      return (rows as unknown as unknown[]).length;
    }
  } catch (err) {
    console.warn(
      "[ai/facts.adjustFactConfidence] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

/**
 * Phase E-12 — check if a user has completed the working-style onboarding
 * (any fact with source='onboarding'). If false, the AskPanel / settings
 * page renders a one-time nudge to fill it in.
 */
export async function hasCompletedOnboarding(email: string): Promise<boolean> {
  try {
    const sql = getSql();
    if (!sql) return true; // fail-safe: don't nag if we can't check
    const rows = await sql`
      SELECT 1 FROM beacon_ai_user_facts
       WHERE email = ${email}
         AND source = 'onboarding'
       LIMIT 1
    `;
    return (rows as unknown as unknown[]).length > 0;
  } catch (err) {
    console.warn(
      "[ai/facts.hasCompletedOnboarding] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return true; // don't nag on errors
  }
}

/** Soft-delete (deactivate) a fact. Keeps the row for audit; just hides
 *  it from the prompt + UI. */
export async function deactivateFact(email: string, id: number): Promise<boolean> {
  try {
    const sql = getSql();
    if (!sql) return false;
    const rows = await sql`
      UPDATE beacon_ai_user_facts
         SET active = FALSE
       WHERE id = ${id}
         AND email = ${email}
       RETURNING id
    `;
    return (rows as unknown as unknown[]).length > 0;
  } catch (err) {
    console.warn(
      "[ai/facts.deactivateFact] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Stable list of users who have conversed in the last EXTRACTION_WINDOW_DAYS.
 *  The extraction cron iterates this list. */
export async function listUsersWithRecentActivity(): Promise<
  Array<{ email: string; turn_count: number }>
> {
  try {
    const sql = getSql();
    if (!sql) return [];
    const rows = await sql`
      SELECT email, COUNT(*)::int AS turn_count
        FROM beacon_ai_conversations
       WHERE ts > NOW() - (${EXTRACTION_WINDOW_DAYS} || ' days')::interval
       GROUP BY email
      HAVING COUNT(*) >= ${EXTRACTION_MIN_TURNS}
       ORDER BY turn_count DESC
    `;
    return rows as unknown as Array<{ email: string; turn_count: number }>;
  } catch (err) {
    console.warn(
      "[ai/facts.listUsersWithRecentActivity] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────
 * Extraction — calls Haiku over a user's recent conversations and
 * asks for a deduplicated list of stable facts about them.
 * ──────────────────────────────────────────────────────────────── */

/**
 * Phase E-12 — sharpened extraction prompt focused on working-style signals.
 *
 * The original prompt lumped style preferences ("3-bullet summaries", "casual
 * tone") under a generic `preference` category. The personalization
 * downstream — the USER PROFILE block injected into the system prompt — only
 * gets meaningfully better when the extracted facts SPLIT style / tone / depth
 * into distinct, actionable categories. The model picks them up as separate
 * dimensions instead of one fuzzy bucket.
 *
 * We expanded the taxonomy to 6 categories:
 *   style    — response length, format (bullets/prose), structure
 *   tone     — terse / warm / formal / friendly
 *   depth    — just-answer vs reasoning vs explore-options
 *   context  — who/what they care about (customers, AMs, pods)
 *   behavior — when/how they use Beacon (mornings, drafts, etc.)
 *   preference — fallback bucket for personalizations that don't fit elsewhere
 *
 * Style/tone/depth are intentionally surfaced FIRST so the extractor primes
 * on them. Recurrence threshold tightened to 3+ occurrences — single
 * one-offs make poor stable facts.
 */
const EXTRACTION_SYSTEM = `You are an extraction agent. Your job is to read a user's recent conversations with Beacon AI (Zoca's internal customer-intelligence copilot) and distill STABLE FACTS about that user — especially their working STYLE — so Beacon AI can personalize future responses.

What counts as a fact (in priority order):

- **style** — How they want responses STRUCTURED.
  Examples: "Prefers responses under 3 sentences." "Wants bullet lists, not paragraphs." "Wants every answer to start with the TL;DR."
  Watch for: explicit asks for shorter/longer responses, recurring requests for bullets vs prose, structural pushback ("too long", "just the answer please"), formatting requests (markdown, headers, etc.).

- **tone** — The VOICE they want.
  Examples: "Prefers terse, direct tone." "Wants warm, encouraging language." "Wants formal phrasing in customer-facing drafts."
  Watch for: corrections of tone ("less corporate", "more direct"), recurring asks for casual vs formal.

- **depth** — How much REASONING they want.
  Examples: "Wants just the answer, no reasoning." "Wants two or three options to choose from." "Wants explanations + the conclusion."
  Watch for: "skip the explanation", "show me the trade-offs", "tl;dr first then details".

- **context** — Who/what they CARE about.
  Examples: "Often asks about Sudha's book." "Focuses on RED customers." "Manages Pod 4."

- **behavior** — When/how they USE Beacon.
  Examples: "Asks Beacon mostly in mornings." "Frequently drafts outreach emails through Beacon." "Uses Beacon to triage inbox first thing."

- **preference** — Anything personalizable that doesn't fit the buckets above (rarely needed; prefer the more specific categories).

What does NOT count:
- A specific customer's data ("ICP score 72" — not a fact about the user).
- One-off questions. The signal must RECUR (3+ occurrences) before it's a stable fact.
- Inferred opinions or speculation about the user's personal life.

OUTPUT RULES:
- Be conservative. Prefer to extract NOTHING over guessing.
- Each fact ≤ 150 chars, standalone, written in second person omitted ("Prefers X", not "The user prefers X").
- Output ONLY a JSON array. No preamble, no markdown fences.
- Schema: [{"fact": "...", "category": "style"|"tone"|"depth"|"context"|"behavior"|"preference"}, ...]
- Maximum 10 facts. Quality over quantity.
- If signal is thin, return [].`;

interface ExtractedFact {
  fact: string;
  category: "preference" | "context" | "behavior" | "style" | "tone" | "depth";
}

const VALID_EXTRACTION_CATEGORIES: readonly string[] = [
  "preference",
  "context",
  "behavior",
  "style",
  "tone",
  "depth",
];

/** Run extraction for ONE user. Reads their last EXTRACTION_WINDOW_DAYS of
 *  conversations across all scopes, asks Haiku for distilled facts, and
 *  upserts them (dedup against existing). */
export async function runExtractionForUser(email: string): Promise<{
  extracted: number;
  added: number;
  reused: number;
  skipped_reason?: string;
}> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { extracted: 0, added: 0, reused: 0, skipped_reason: "no_api_key" };
  }

  const turns = await getRecentCrossScope(email, null, 80);
  if (turns.length < EXTRACTION_MIN_TURNS) {
    return { extracted: 0, added: 0, reused: 0, skipped_reason: "too_few_turns" };
  }

  const transcript = turns
    .map((t) => {
      const speaker = t.role === "user" ? "User" : "Beacon";
      const body = t.content.length > 600 ? t.content.slice(0, 600) + "…" : t.content;
      return `${speaker} [${t.scope_key} · ${t.ts.slice(0, 10)}]: ${body}`;
    })
    .join("\n\n");

  let extracted: ExtractedFact[] = [];
  try {
    const res = await anthropic.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: EXTRACTION_MAX_TOKENS,
      system: EXTRACTION_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Here are the user's last ${turns.length} Beacon AI conversation turns from the past ${EXTRACTION_WINDOW_DAYS} days. Extract stable facts about them following the rules above. Output ONLY the JSON array — no preamble, no markdown fences.\n\n${transcript}`,
        },
      ],
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    // Lenient parse: find the first [ and last ] and slice.
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end < 0) {
      return {
        extracted: 0,
        added: 0,
        reused: 0,
        skipped_reason: "no_json_array",
      };
    }
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) {
      return {
        extracted: 0,
        added: 0,
        reused: 0,
        skipped_reason: "json_not_array",
      };
    }
    extracted = parsed
      .filter(
        (f): f is ExtractedFact =>
          !!f &&
          typeof f === "object" &&
          typeof (f as { fact?: unknown }).fact === "string" &&
          VALID_EXTRACTION_CATEGORIES.includes(
            (f as { category?: unknown }).category as string,
          ),
      )
      .slice(0, 10);
  } catch (err) {
    return {
      extracted: 0,
      added: 0,
      reused: 0,
      skipped_reason: err instanceof Error ? err.message.slice(0, 80) : "unknown",
    };
  }

  if (extracted.length === 0) {
    return { extracted: 0, added: 0, reused: 0, skipped_reason: "empty_extraction" };
  }

  // Upsert each extracted fact — refresh last_seen + bump confidence if
  // it already exists, otherwise insert new.
  let added = 0;
  let reused = 0;
  const sql = getSql();
  if (!sql) {
    return {
      extracted: extracted.length,
      added: 0,
      reused: 0,
      skipped_reason: "no_db",
    };
  }

  for (const f of extracted) {
    const fact = f.fact.trim().slice(0, MAX_FACT_CHARS);
    if (!fact) continue;
    try {
      const existing = await sql`
        SELECT id, confidence::float AS confidence FROM beacon_ai_user_facts
         WHERE email = ${email}
           AND LOWER(fact) = LOWER(${fact})
         LIMIT 1
      `;
      const rows = existing as unknown as Array<{ id: number; confidence: number }>;
      if (rows.length > 0) {
        // Re-encountered → bump confidence (cap 1.00), refresh seen, ensure active
        const newConfidence = Math.min(1, rows[0].confidence + 0.05);
        await sql`
          UPDATE beacon_ai_user_facts
             SET last_seen_at = NOW(),
                 confidence = ${newConfidence},
                 reference_count = reference_count + 1,
                 active = TRUE
           WHERE id = ${rows[0].id}
        `;
        reused += 1;
      } else {
        await sql`
          INSERT INTO beacon_ai_user_facts
            (email, fact, category, source, confidence)
          VALUES
            (${email}, ${fact}, ${f.category}, 'extracted', 0.85)
        `;
        added += 1;
      }
    } catch (err) {
      console.warn(
        "[ai/facts.runExtractionForUser] upsert failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { extracted: extracted.length, added, reused };
}

/**
 * Render active facts as a USER PROFILE block for the system prompt.
 * Returns null when the user has no facts (caller can skip injecting the
 * empty section to save tokens).
 *
 * Phase E-12 — sections now include style/tone/depth/onboarding distinctly
 * so the model picks them up as separate dimensions instead of fuzzy
 * preferences. Order matters: style first, then tone, then depth — these
 * are the most actionable for every single response. Context + behavior
 * sit lower; they shape topic-level reasoning rather than response shape.
 */
export function renderFactsForPrompt(facts: UserFact[]): string | null {
  if (facts.length === 0) return null;
  const byCat: Record<string, string[]> = {
    explicit: [],
    onboarding: [],
    style: [],
    tone: [],
    depth: [],
    preference: [],
    context: [],
    behavior: [],
  };
  for (const f of facts) {
    const cat = f.category || "explicit";
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(`- ${f.fact}`);
  }
  const sections: string[] = [];
  // High-confidence explicit + onboarding first so the model treats them as
  // hard constraints, not soft preferences.
  if (byCat.explicit.length > 0)
    sections.push(`User-stated facts (treat as hard constraints):\n${byCat.explicit.join("\n")}`);
  if (byCat.onboarding.length > 0)
    sections.push(`Working-style preferences (set during onboarding — apply to every response):\n${byCat.onboarding.join("\n")}`);
  if (byCat.style.length > 0)
    sections.push(`Response style:\n${byCat.style.join("\n")}`);
  if (byCat.tone.length > 0)
    sections.push(`Tone:\n${byCat.tone.join("\n")}`);
  if (byCat.depth.length > 0)
    sections.push(`Reasoning depth:\n${byCat.depth.join("\n")}`);
  if (byCat.preference.length > 0)
    sections.push(`Other preferences:\n${byCat.preference.join("\n")}`);
  if (byCat.context.length > 0)
    sections.push(`Context they care about:\n${byCat.context.join("\n")}`);
  if (byCat.behavior.length > 0)
    sections.push(`Behavior patterns:\n${byCat.behavior.join("\n")}`);
  return sections.join("\n\n");
}
