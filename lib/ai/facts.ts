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

export type FactCategory =
  | "preference"
  | "context"
  | "behavior"
  | "explicit"
  | null;

export type FactSource = "extracted" | "explicit";

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

/** All active facts for one user, most-recently-seen first. */
export async function listFactsForUser(
  email: string,
  opts: { includeInactive?: boolean } = {},
): Promise<UserFact[]> {
  try {
    const sql = getSql();
    if (!sql) return [];
    const rows = opts.includeInactive
      ? await sql`
          SELECT id, email, fact, category, source,
                 confidence::float AS confidence,
                 created_at::text AS created_at,
                 last_seen_at::text AS last_seen_at,
                 reference_count, active
            FROM beacon_ai_user_facts
           WHERE email = ${email}
           ORDER BY active DESC, last_seen_at DESC
           LIMIT 200
        `
      : await sql`
          SELECT id, email, fact, category, source,
                 confidence::float AS confidence,
                 created_at::text AS created_at,
                 last_seen_at::text AS last_seen_at,
                 reference_count, active
            FROM beacon_ai_user_facts
           WHERE email = ${email}
             AND active = TRUE
           ORDER BY last_seen_at DESC
           LIMIT ${MAX_FACTS_PER_USER}
        `;
    return rows as unknown as UserFact[];
  } catch (err) {
    console.warn(
      "[ai/facts.listFactsForUser] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/** Add an explicit fact (user-typed via /remember). Deduplicates against
 *  existing facts by lowercase comparison; if a duplicate exists, refreshes
 *  last_seen_at instead of inserting. */
export async function addExplicitFact(input: {
  email: string;
  fact: string;
}): Promise<{ id: number; reused: boolean } | null> {
  try {
    const sql = getSql();
    if (!sql) return null;
    const fact = input.fact.trim().slice(0, MAX_FACT_CHARS);
    if (!fact) return null;

    // Dedup check
    const existing = await sql`
      SELECT id FROM beacon_ai_user_facts
       WHERE email = ${input.email}
         AND LOWER(fact) = LOWER(${fact})
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
        (email, fact, category, source, confidence)
      VALUES
        (${input.email}, ${fact}, 'explicit', 'explicit', 1.00)
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

const EXTRACTION_SYSTEM = `You are an extraction agent. Your only job is to read a user's recent conversations with Beacon AI (Zoca's internal customer-intelligence copilot) and distill STABLE FACTS about that user that would help Beacon AI personalize future responses.

What counts as a fact:
- **Preferences**: How they like Beacon to respond. "Prefers 3-bullet summaries." "Wants email drafts in casual tone." "Likes Markdown bullets, not paragraphs."
- **Context**: Who they care about. "Often asks about Sudha's book." "Focuses on RED customers." "Manages the Apurvaa pod."
- **Behavior**: How they use Beacon. "Asks Beacon mostly in mornings." "Frequently drafts outreach emails through Beacon."

What does NOT count:
- Anything about a specific customer's data — that's stored elsewhere.
- One-off questions ("they asked about SkinSpa NYC once" is NOT a stable fact).
- Inferred political/personal opinions.

OUTPUT RULES:
- Be conservative. Only output facts you have HIGH confidence about based on RECURRING patterns in the conversations.
- Each fact must be a single short sentence (under 150 characters).
- Each fact should stand alone — Beacon AI should understand it without conversation context.
- Output as a JSON array of objects: [{"fact": "...", "category": "preference"|"context"|"behavior"}, ...]
- If you don't have enough signal to extract anything confidently, return an empty array.
- Maximum 10 facts per extraction. Quality over quantity.`;

interface ExtractedFact {
  fact: string;
  category: "preference" | "context" | "behavior";
}

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
          ["preference", "context", "behavior"].includes(
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
 */
export function renderFactsForPrompt(facts: UserFact[]): string | null {
  if (facts.length === 0) return null;
  const byCat: Record<string, string[]> = {
    preference: [],
    context: [],
    behavior: [],
    explicit: [],
  };
  for (const f of facts) {
    const cat = f.category || "explicit";
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(`- ${f.fact}`);
  }
  const sections: string[] = [];
  if (byCat.explicit.length > 0)
    sections.push(`User-stated facts (high confidence):\n${byCat.explicit.join("\n")}`);
  if (byCat.preference.length > 0)
    sections.push(`Preferences:\n${byCat.preference.join("\n")}`);
  if (byCat.context.length > 0)
    sections.push(`Context they care about:\n${byCat.context.join("\n")}`);
  if (byCat.behavior.length > 0)
    sections.push(`Behavior patterns:\n${byCat.behavior.join("\n")}`);
  return sections.join("\n\n");
}
