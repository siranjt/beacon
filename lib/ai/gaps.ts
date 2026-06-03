/**
 * Beacon AI failure inbox — gap parser + logger.
 *
 * Phase F-polish-AI Tier 3.
 *
 * The model tags its own "can't fully answer" responses with inline
 * markers shaped like:
 *
 *     <gap: <category> — <terse description>>
 *
 * Examples we expect to see in real traffic:
 *
 *     <gap: data_missing — silence-by-pod at 45-day threshold>
 *     <gap: data_missing — MRR distribution histogram>
 *     <gap: tool_insufficient — query_customer_book can't group by city>
 *     <gap: out_of_scope — financial forecasting question>
 *     <gap: assumption_unclear — "best AM" undefined; ask by what metric>
 *
 * The four categories are the only valid tags. Anything else is treated
 * as a malformed marker and ignored (the model occasionally invents
 * extra wording; this keeps the logger conservative).
 *
 * The em-dash separator is canonical; we tolerate a regular dash or a
 * colon as a fallback because Sonnet occasionally drifts.
 *
 * Markers are STRIPPED from the visible assistant text by the client
 * renderer (see `stripGapMarkers` below — exported so the streaming
 * endpoint can use it before persisting the assistant turn).
 */

import { getSql } from "@/lib/customer/postgres";

export type GapCategory =
  | "data_missing"
  | "tool_insufficient"
  | "out_of_scope"
  | "assumption_unclear";

export interface ParsedGap {
  category: GapCategory;
  description: string;
}

const VALID_CATEGORIES: GapCategory[] = [
  "data_missing",
  "tool_insufficient",
  "out_of_scope",
  "assumption_unclear",
];

// Pattern matches `<gap: category SEP description>` where SEP is em-dash,
// hyphen, or colon (tolerant of model phrasing drift). Captures category
// and description. Greedy on description but bounded by the closing `>`.
//
// Multiline / global so a single assistant turn with multiple gaps emits
// multiple matches.
const GAP_PATTERN = /<gap:\s*([a-z_]+)\s*[—:\-]\s*([^>]+?)\s*>/gi;

/**
 * Extract every gap marker from an assistant response. Order preserved;
 * duplicates within a single response collapsed (same category +
 * normalized description). Empty array when the response has no
 * markers — that's the common case for normal answers.
 */
export function parseGaps(text: string): ParsedGap[] {
  if (!text) return [];
  const out: ParsedGap[] = [];
  const seen = new Set<string>();
  GAP_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GAP_PATTERN.exec(text)) !== null) {
    const rawCategory = m[1]?.toLowerCase().trim() ?? "";
    const rawDescription = m[2]?.trim() ?? "";
    if (!VALID_CATEGORIES.includes(rawCategory as GapCategory)) {
      // Malformed — model emitted some other category. Skip silently.
      continue;
    }
    if (!rawDescription) continue;
    const key = `${rawCategory}::${rawDescription.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      category: rawCategory as GapCategory,
      description: rawDescription,
    });
  }
  return out;
}

/**
 * Remove every gap marker from the response so the user-visible text is
 * clean. We do this on the server side before persisting the assistant
 * turn — the markers are operational metadata, not part of the answer.
 * (The streaming SSE already strips them client-side too as a fallback.)
 */
export function stripGapMarkers(text: string): string {
  if (!text) return text;
  return text.replace(GAP_PATTERN, "").replace(/\s+\n/g, "\n").trim();
}

/* ──────────────────────────────────────────────────────────────────
 * Logger
 * ──────────────────────────────────────────────────────────────── */

export interface LogGapInput {
  scope: string;
  scope_meta: Record<string, unknown> | null;
  user_email: string;
  user_role: "admin" | "manager" | "am" | null;
  question: string;
  full_response: string;
  conversation_id: number | null;
  gaps: ParsedGap[];
}

const RESPONSE_TRUNCATE = 4000;

/**
 * Persist one row per gap. Best-effort: if the DB write throws we log
 * to console but don't bubble — the ask route should NEVER fail because
 * the failure inbox itself is broken.
 */
export async function logGaps(input: LogGapInput): Promise<void> {
  if (input.gaps.length === 0) return;
  try {
    const sql = getSql();
    if (!sql) return;
    const truncatedResponse = input.full_response.slice(0, RESPONSE_TRUNCATE);
    for (const g of input.gaps) {
      await sql`
        INSERT INTO beacon_ai_failure_log (
          scope, scope_meta, user_email, user_role,
          question, category, description, full_response, conversation_id
        ) VALUES (
          ${input.scope},
          ${input.scope_meta ? JSON.stringify(input.scope_meta) : null}::jsonb,
          ${input.user_email},
          ${input.user_role},
          ${input.question},
          ${g.category},
          ${g.description},
          ${truncatedResponse},
          ${input.conversation_id}
        )
      `;
    }
  } catch (e) {
    // Never block the user-facing turn on telemetry failures. The model
    // already answered; the gap row is operational metadata only.
    console.warn("[beacon-ai-gaps] logGaps failed:", e);
  }
}

/* ──────────────────────────────────────────────────────────────────
 * Reader (used by the admin view)
 * ──────────────────────────────────────────────────────────────── */

export interface GapLogRow {
  id: number;
  occurred_at: string;
  scope: string;
  scope_meta: Record<string, unknown> | null;
  user_email: string;
  user_role: string | null;
  question: string;
  category: GapCategory;
  description: string;
  full_response: string | null;
  conversation_id: number | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

/**
 * Recent gap rows for the admin inbox. Default: 200 most recent
 * unresolved, newest first. Pass includeResolved=true to see the full
 * history.
 */
export async function listGapRows(opts: {
  scope?: string;
  category?: GapCategory;
  includeResolved?: boolean;
  limit?: number;
} = {}): Promise<GapLogRow[]> {
  const sql = getSql();
  if (!sql) return [];
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const scopeFilter = opts.scope ?? null;
  const categoryFilter = opts.category ?? null;
  const includeResolved = opts.includeResolved ?? false;

  const rows = (await sql`
    SELECT id, occurred_at, scope, scope_meta, user_email, user_role,
           question, category, description, full_response, conversation_id,
           resolved_at, resolved_by, resolution_note
    FROM beacon_ai_failure_log
    WHERE
      (${scopeFilter}::text IS NULL OR scope = ${scopeFilter}::text)
      AND (${categoryFilter}::text IS NULL OR category = ${categoryFilter}::text)
      AND (${includeResolved} OR resolved_at IS NULL)
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `) as unknown as GapLogRow[];

  return rows;
}

/**
 * Mark a gap as resolved (admin closes it after shipping a fix).
 */
export async function resolveGap(args: {
  id: number;
  admin_email: string;
  note: string | null;
}): Promise<void> {
  const sql = getSql();
  if (!sql) return;
  await sql`
    UPDATE beacon_ai_failure_log
    SET resolved_at = now(),
        resolved_by = ${args.admin_email},
        resolution_note = ${args.note}
    WHERE id = ${args.id} AND resolved_at IS NULL
  `;
}

/**
 * Rollup: count of (open + total) gaps per (scope, category). Used by
 * the admin view header to show the rate of each failure class.
 */
export interface GapRollup {
  scope: string;
  category: GapCategory;
  open_count: number;
  total_count: number;
}

export async function gapRollup(): Promise<GapRollup[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = (await sql`
    SELECT scope,
           category,
           COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open_count,
           COUNT(*)::int AS total_count
    FROM beacon_ai_failure_log
    GROUP BY scope, category
    ORDER BY open_count DESC, total_count DESC
  `) as unknown as GapRollup[];
  return rows;
}
