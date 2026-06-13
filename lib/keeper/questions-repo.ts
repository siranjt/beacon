/**
 * WAVE-B Keeper Question Bank — CRUD repository.
 *
 * Why this module exists
 * ----------------------
 * Centralizes every read/write against keeper_questions so the cron, the
 * AM-facing API routes, and the Beam strip all go through one validated
 * code path. Mirrors the lib/ai/gaps.ts pattern — `getSql()` from
 * lib/customer/postgres.ts, soft-fail to empty arrays / nulls when
 * POSTGRES_URL isn't set, and never throw on the read side (the strip
 * must degrade gracefully on a flaky DB).
 *
 * The table is small (one row per pending question, terminal rows kept
 * for audit) so no special caching strategy is needed beyond the
 * existing index design in 2026-06-13-keeper-questions.sql.
 */

import { getSql } from "@/lib/customer/postgres";

export type KeeperQuestionCategory =
  | "data_missing"
  | "tool_insufficient"
  | "out_of_scope"
  | "assumption_unclear";

export type KeeperQuestionStatus = "pending" | "answered" | "dismissed";

export interface KeeperQuestionRow {
  id: number;
  created_at: string;
  customer_id: string | null;
  entity_id: string | null;
  question_text: string;
  source_failure_log_ids: number[];
  cluster_signature: string;
  category: KeeperQuestionCategory;
  status: KeeperQuestionStatus;
  answered_at: string | null;
  answered_by: string | null;
  answer_fact_id: string | null;
  dismissed_at: string | null;
  dismissed_by: string | null;
}

export interface CreateKeeperQuestionInput {
  customer_id: string | null;
  entity_id: string | null;
  question_text: string;
  source_failure_log_ids: Array<number | bigint>;
  cluster_signature: string;
  category: KeeperQuestionCategory;
}

/**
 * Insert a new pending question. The partial unique index on
 * `cluster_signature WHERE status = 'pending'` rejects regen of an
 * already-pending question; we swallow that conflict and return null
 * so the caller (the cron) can keep going.
 *
 * Returns the inserted row id, or null when the DB is unavailable or
 * the cluster_signature already has a pending row.
 */
export async function createQuestion(
  input: CreateKeeperQuestionInput,
): Promise<number | null> {
  const sql = getSql();
  if (!sql) return null;

  // Cast every id to a JS number — bigint round-trips through Neon's
  // template-literal binding as a string and Postgres complains when it
  // sees a string in a BIGINT[] literal.
  const sourceIds = input.source_failure_log_ids.map((x) => Number(x));

  try {
    const rows = (await sql`
      INSERT INTO keeper_questions (
        customer_id, entity_id, question_text,
        source_failure_log_ids, cluster_signature, category
      ) VALUES (
        ${input.customer_id},
        ${input.entity_id},
        ${input.question_text},
        ${sourceIds}::bigint[],
        ${input.cluster_signature},
        ${input.category}
      )
      ON CONFLICT (cluster_signature) WHERE status = 'pending'
      DO NOTHING
      RETURNING id
    `) as Array<{ id: number }>;
    if (rows.length === 0) return null;
    return rows[0].id;
  } catch (e) {
    // Older Postgres versions (and some Neon configurations) don't accept
    // ON CONFLICT ... WHERE on partial unique indexes via the SQL layer.
    // Fall back to a pre-check.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ON CONFLICT")) {
      const existing = (await sql`
        SELECT id FROM keeper_questions
        WHERE cluster_signature = ${input.cluster_signature}
          AND status = 'pending'
        LIMIT 1
      `) as Array<{ id: number }>;
      if (existing.length > 0) return null;
      const rows = (await sql`
        INSERT INTO keeper_questions (
          customer_id, entity_id, question_text,
          source_failure_log_ids, cluster_signature, category
        ) VALUES (
          ${input.customer_id},
          ${input.entity_id},
          ${input.question_text},
          ${sourceIds}::bigint[],
          ${input.cluster_signature},
          ${input.category}
        )
        RETURNING id
      `) as Array<{ id: number }>;
      return rows[0]?.id ?? null;
    }
    console.warn("[keeper-questions-repo] createQuestion failed:", msg);
    return null;
  }
}

/**
 * Pending questions for a specific customer (used by the strip mounted
 * on a single-customer view). Newest first; capped at `limit`.
 */
export async function listPendingForCustomer(
  customer_id: string,
  limit = 3,
): Promise<KeeperQuestionRow[]> {
  const sql = getSql();
  if (!sql) return [];
  const cap = Math.min(Math.max(limit, 1), 25);
  try {
    const rows = (await sql`
      SELECT id, created_at, customer_id, entity_id, question_text,
             source_failure_log_ids, cluster_signature, category, status,
             answered_at, answered_by, answer_fact_id,
             dismissed_at, dismissed_by
      FROM keeper_questions
      WHERE customer_id = ${customer_id}
        AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${cap}
    `) as unknown as KeeperQuestionRow[];
    return rows;
  } catch (e) {
    console.warn(
      "[keeper-questions-repo] listPendingForCustomer failed:",
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

/**
 * Pending questions for a user (book-level view). The user_email is
 * currently unused as a filter — we don't yet attribute questions back
 * to an AM email — but the signature keeps that future filter cheap to
 * add. For now this returns the newest pending questions globally,
 * capped at `limit`.
 */
export async function listPendingForUser(
  user_email: string,
  limit = 10,
): Promise<KeeperQuestionRow[]> {
  const sql = getSql();
  if (!sql) return [];
  const cap = Math.min(Math.max(limit, 1), 50);
  // Parameter retained for the future attribution wire-up.
  void user_email;
  try {
    const rows = (await sql`
      SELECT id, created_at, customer_id, entity_id, question_text,
             source_failure_log_ids, cluster_signature, category, status,
             answered_at, answered_by, answer_fact_id,
             dismissed_at, dismissed_by
      FROM keeper_questions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${cap}
    `) as unknown as KeeperQuestionRow[];
    return rows;
  } catch (e) {
    console.warn(
      "[keeper-questions-repo] listPendingForUser failed:",
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

/**
 * Mark a pending question as answered + bind it to the Keeper fact the
 * answer just created. No-op if the question is already terminal.
 */
export async function markAnswered(
  id: number,
  fact_id: string,
  user_email: string,
): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  try {
    const rows = (await sql`
      UPDATE keeper_questions
      SET status = 'answered',
          answered_at = now(),
          answered_by = ${user_email},
          answer_fact_id = ${fact_id}::uuid
      WHERE id = ${id} AND status = 'pending'
      RETURNING id
    `) as Array<{ id: number }>;
    return rows.length > 0;
  } catch (e) {
    console.warn(
      "[keeper-questions-repo] markAnswered failed:",
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

/**
 * Mark a pending question as dismissed. No-op if already terminal.
 */
export async function markDismissed(
  id: number,
  user_email: string,
): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  try {
    const rows = (await sql`
      UPDATE keeper_questions
      SET status = 'dismissed',
          dismissed_at = now(),
          dismissed_by = ${user_email}
      WHERE id = ${id} AND status = 'pending'
      RETURNING id
    `) as Array<{ id: number }>;
    return rows.length > 0;
  } catch (e) {
    console.warn(
      "[keeper-questions-repo] markDismissed failed:",
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

/**
 * Look up a single question by id. Used by the answer + dismiss routes
 * to confirm the row exists + sanity-check the requested transition.
 */
export async function getById(id: number): Promise<KeeperQuestionRow | null> {
  const sql = getSql();
  if (!sql) return null;
  try {
    const rows = (await sql`
      SELECT id, created_at, customer_id, entity_id, question_text,
             source_failure_log_ids, cluster_signature, category, status,
             answered_at, answered_by, answer_fact_id,
             dismissed_at, dismissed_by
      FROM keeper_questions
      WHERE id = ${id}
      LIMIT 1
    `) as unknown as KeeperQuestionRow[];
    return rows[0] ?? null;
  } catch (e) {
    console.warn(
      "[keeper-questions-repo] getById failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/**
 * Check whether a cluster_signature already has a PENDING row. Used by
 * the cron to gate Haiku calls — no need to spend the token if a
 * question for this exact cluster is still awaiting an AM answer.
 */
export async function pendingSignatureExists(
  cluster_signature: string,
): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  try {
    const rows = (await sql`
      SELECT 1 FROM keeper_questions
      WHERE cluster_signature = ${cluster_signature}
        AND status = 'pending'
      LIMIT 1
    `) as Array<{ "?column?": number }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}
