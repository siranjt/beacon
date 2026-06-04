/**
 * Beacon Brain — repository layer.
 *
 * All read/write access to beacon_brain_facts + beacon_brain_fact_versions
 * goes through this module. Write paths always emit a version-log row so
 * the full history is recoverable.
 *
 * Wave 1 scope: writes (insert + confirm), reads (by customer, by candidate).
 * Conflict detection, sunset sweeps, and edit/refine flows ship in
 * subsequent waves.
 */

import { getSql } from "../customer/postgres";
import type {
  BrainFact,
  BrainFactVersion,
  BrainFactWrite,
  TopicSubcategory,
  TopicCategory,
  ConfidenceState,
  ChangeReason,
} from "./types";
import { categoryForSubcategory, isNamedField } from "./types";

/**
 * Write a new fact OR upsert if a row already exists for the same
 * (customer_id, topic_subcategory, field_name) tuple AND the field is
 * a named (non-'other') field.
 *
 * For 'other' rows, this always inserts a new row — unlimited 'other'
 * entries per subcategory by design.
 *
 * Idempotent: if the value matches an existing row exactly, no version
 * row is written.
 *
 * Returns the resulting BrainFact (either newly-inserted or existing).
 */
export async function writeBrainFact(
  input: BrainFactWrite,
): Promise<BrainFact | null> {
  const sql = getSql();
  if (!sql) {
    console.warn("[brain] POSTGRES_URL not set — skipping write");
    return null;
  }

  // Validate topic_subcategory ↔ topic_category consistency. Server-side
  // safety check so callers can't write a behavioral subcategory under
  // the identity category by accident.
  const expectedCategory: TopicCategory = categoryForSubcategory(
    input.topic_subcategory,
  );
  if (input.topic_category !== expectedCategory) {
    throw new Error(
      `[brain] category mismatch: ${input.topic_category} vs expected ${expectedCategory} for ${input.topic_subcategory}`,
    );
  }

  const named = isNamedField(input.topic_subcategory, input.field_name);
  // 'other' field_name OR an unknown field — both allowed but neither
  // can collide on the (customer_id, subcategory, field_name) unique
  // index (because the index has WHERE field_name != 'other'). So they
  // always insert as new rows.
  // Named fields can collide and need upsert handling.

  const confState: ConfidenceState = input.confirmed_by_email
    ? "confirmed"
    : "candidate";
  const confTime = input.confirmed_by_email ? new Date().toISOString() : null;

  if (!named || input.field_name === "other") {
    // Insert-only path.
    const rows = (await sql`
      INSERT INTO beacon_brain_facts (
        customer_id, topic_category, topic_subcategory, field_name, value,
        confidence_state, source_type, source_ref, owning_am_email,
        confirmed_by_email, confirmed_at, sunset_at
      ) VALUES (
        ${input.customer_id},
        ${input.topic_category},
        ${input.topic_subcategory},
        ${input.field_name},
        ${input.value},
        ${confState},
        ${input.source_type},
        ${input.source_ref ?? null},
        ${input.owning_am_email ?? null},
        ${input.confirmed_by_email ?? null},
        ${confTime},
        ${input.sunset_at ?? null}
      )
      RETURNING *
    `) as BrainFact[];
    const newRow = rows[0];
    if (newRow) {
      await writeVersion({
        customer_id: newRow.customer_id,
        fact_id: newRow.fact_id,
        version: 1,
        value: newRow.value,
        confidence_state: newRow.confidence_state,
        source_type: newRow.source_type,
        source_ref: newRow.source_ref,
        prior_value: null,
        changed_by_email: input.confirmed_by_email ?? input.owning_am_email ?? "system",
        change_reason: "create",
      });
    }
    return newRow ?? null;
  }

  // Named field path: check for existing row, upsert if present.
  const existing = (await sql`
    SELECT * FROM beacon_brain_facts
    WHERE customer_id = ${input.customer_id}
      AND topic_subcategory = ${input.topic_subcategory}
      AND field_name = ${input.field_name}
      AND soft_deleted_at IS NULL
    LIMIT 1
  `) as BrainFact[];

  if (existing.length === 0) {
    // No existing row — insert as new.
    const rows = (await sql`
      INSERT INTO beacon_brain_facts (
        customer_id, topic_category, topic_subcategory, field_name, value,
        confidence_state, source_type, source_ref, owning_am_email,
        confirmed_by_email, confirmed_at, sunset_at
      ) VALUES (
        ${input.customer_id},
        ${input.topic_category},
        ${input.topic_subcategory},
        ${input.field_name},
        ${input.value},
        ${confState},
        ${input.source_type},
        ${input.source_ref ?? null},
        ${input.owning_am_email ?? null},
        ${input.confirmed_by_email ?? null},
        ${confTime},
        ${input.sunset_at ?? null}
      )
      RETURNING *
    `) as BrainFact[];
    const newRow = rows[0];
    if (newRow) {
      await writeVersion({
        customer_id: newRow.customer_id,
        fact_id: newRow.fact_id,
        version: 1,
        value: newRow.value,
        confidence_state: newRow.confidence_state,
        source_type: newRow.source_type,
        source_ref: newRow.source_ref,
        prior_value: null,
        changed_by_email: input.confirmed_by_email ?? input.owning_am_email ?? "system",
        change_reason: "create",
      });
    }
    return newRow ?? null;
  }

  // Existing row — idempotency check, then upsert.
  const current = existing[0];
  if (current.value === input.value && current.source_type === input.source_type) {
    // Identical write — no-op. Bump updated_at only.
    await sql`
      UPDATE beacon_brain_facts
      SET updated_at = NOW()
      WHERE fact_id = ${current.fact_id}
    `;
    return current;
  }

  // Different value — write a version-log row and update the live row.
  // For Wave 1, this path is treated as an edit, not a conflict (the
  // semantic-Haiku conflict check ships in Wave 2 alongside the
  // add_fact_to_brain conversational tool).
  const newVersion = current.current_version + 1;
  const updated = (await sql`
    UPDATE beacon_brain_facts
    SET value = ${input.value},
        source_type = ${input.source_type},
        source_ref = ${input.source_ref ?? null},
        current_version = ${newVersion},
        updated_at = NOW(),
        confirmed_by_email = COALESCE(${input.confirmed_by_email ?? null}, confirmed_by_email),
        confirmed_at = CASE
          WHEN ${input.confirmed_by_email ?? null}::text IS NOT NULL
          THEN NOW()
          ELSE confirmed_at
        END
    WHERE fact_id = ${current.fact_id}
    RETURNING *
  `) as BrainFact[];

  const updatedRow = updated[0];
  if (updatedRow) {
    await writeVersion({
      customer_id: updatedRow.customer_id,
      fact_id: updatedRow.fact_id,
      version: newVersion,
      value: updatedRow.value,
      confidence_state: updatedRow.confidence_state,
      source_type: updatedRow.source_type,
      source_ref: updatedRow.source_ref,
      prior_value: current.value,
      changed_by_email: input.confirmed_by_email ?? input.owning_am_email ?? "system",
      change_reason: "edit",
    });
  }
  return updatedRow ?? null;
}

/** Append-only version log write. Called internally on every material change. */
async function writeVersion(input: {
  customer_id: string;
  fact_id: string;
  version: number;
  value: string;
  confidence_state: ConfidenceState;
  source_type: string;
  source_ref: string | null;
  prior_value: string | null;
  changed_by_email: string;
  change_reason: ChangeReason;
}): Promise<void> {
  const sql = getSql();
  if (!sql) return;
  await sql`
    INSERT INTO beacon_brain_fact_versions (
      customer_id, fact_id, version, value, confidence_state,
      source_type, source_ref, prior_value, changed_by_email, change_reason
    ) VALUES (
      ${input.customer_id},
      ${input.fact_id},
      ${input.version},
      ${input.value},
      ${input.confidence_state},
      ${input.source_type},
      ${input.source_ref},
      ${input.prior_value},
      ${input.changed_by_email},
      ${input.change_reason}
    )
  `;
}

/** Read all non-deleted facts for a customer. Used by Beacon AI retrieval + the Brain panel. */
export async function getFactsForCustomer(
  customer_id: string,
  opts: { confirmedOnly?: boolean } = {},
): Promise<BrainFact[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = opts.confirmedOnly
    ? ((await sql`
        SELECT * FROM beacon_brain_facts
        WHERE customer_id = ${customer_id}
          AND confidence_state = 'confirmed'
          AND soft_deleted_at IS NULL
          AND (sunset_at IS NULL OR sunset_at > NOW())
        ORDER BY topic_category, topic_subcategory, field_name
      `) as BrainFact[])
    : ((await sql`
        SELECT * FROM beacon_brain_facts
        WHERE customer_id = ${customer_id}
          AND soft_deleted_at IS NULL
        ORDER BY topic_category, topic_subcategory, field_name
      `) as BrainFact[]);
  return rows;
}

/** Validate inbox query — candidates pending confirmation. */
export async function getCandidatesByAm(
  am_email: string,
  limit: number = 200,
): Promise<BrainFact[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = (await sql`
    SELECT * FROM beacon_brain_facts
    WHERE owning_am_email = ${am_email}
      AND confidence_state = 'candidate'
      AND soft_deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as BrainFact[];
  return rows;
}

/** Manager view — all candidates across the book. */
export async function getAllCandidates(limit: number = 500): Promise<BrainFact[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = (await sql`
    SELECT * FROM beacon_brain_facts
    WHERE confidence_state = 'candidate'
      AND soft_deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as BrainFact[];
  return rows;
}

/**
 * Confirm a candidate fact. Flips confidence_state to 'confirmed',
 * stamps confirmed_by_email + confirmed_at, writes a 'confirm' version row.
 *
 * Returns the updated fact, or null if the fact wasn't found / already
 * confirmed.
 */
export async function confirmFact(
  fact_id: string,
  confirmed_by_email: string,
): Promise<BrainFact | null> {
  const sql = getSql();
  if (!sql) return null;
  const existing = (await sql`
    SELECT * FROM beacon_brain_facts
    WHERE fact_id = ${fact_id}
      AND confidence_state = 'candidate'
      AND soft_deleted_at IS NULL
    LIMIT 1
  `) as BrainFact[];
  if (existing.length === 0) return null;
  const current = existing[0];
  const newVersion = current.current_version + 1;
  const updated = (await sql`
    UPDATE beacon_brain_facts
    SET confidence_state = 'confirmed',
        confirmed_by_email = ${confirmed_by_email},
        confirmed_at = NOW(),
        current_version = ${newVersion},
        updated_at = NOW()
    WHERE fact_id = ${fact_id}
    RETURNING *
  `) as BrainFact[];
  const updatedRow = updated[0];
  if (updatedRow) {
    await writeVersion({
      customer_id: updatedRow.customer_id,
      fact_id: updatedRow.fact_id,
      version: newVersion,
      value: updatedRow.value,
      confidence_state: "confirmed",
      source_type: updatedRow.source_type,
      source_ref: updatedRow.source_ref,
      prior_value: null,
      changed_by_email: confirmed_by_email,
      change_reason: "confirm",
    });
  }
  return updatedRow ?? null;
}

/** Read version log for a fact (newest first). */
export async function getFactHistory(
  fact_id: string,
): Promise<BrainFactVersion[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = (await sql`
    SELECT * FROM beacon_brain_fact_versions
    WHERE fact_id = ${fact_id}
    ORDER BY version DESC
  `) as BrainFactVersion[];
  return rows;
}

/** Lightweight rollup: facts-per-customer counts for the launch dashboard. */
export async function getBrainRollup(): Promise<{
  total_facts: number;
  confirmed: number;
  candidate: number;
  customers_with_brain: number;
}> {
  const sql = getSql();
  if (!sql) {
    return { total_facts: 0, confirmed: 0, candidate: 0, customers_with_brain: 0 };
  }
  const rows = (await sql`
    SELECT
      COUNT(*)::int AS total_facts,
      COUNT(*) FILTER (WHERE confidence_state = 'confirmed')::int AS confirmed,
      COUNT(*) FILTER (WHERE confidence_state = 'candidate')::int AS candidate,
      COUNT(DISTINCT customer_id)::int AS customers_with_brain
    FROM beacon_brain_facts
    WHERE soft_deleted_at IS NULL
  `) as Array<{
    total_facts: number;
    confirmed: number;
    candidate: number;
    customers_with_brain: number;
  }>;
  return (
    rows[0] ?? {
      total_facts: 0,
      confirmed: 0,
      candidate: 0,
      customers_with_brain: 0,
    }
  );
}

/**
 * Manager cross-book search. Returns matching confirmed facts across
 * every customer, optionally filtered by topic_subcategory, field_name,
 * and a value substring (ILIKE).
 *
 * Used by the query_brain tool (Wave 2a.3) so managers can ask Beacon AI
 * things like "which customers prefer WhatsApp?" or "show all latent
 * risks in the book".
 *
 * Returns up to `limit` rows. The caller is responsible for joining to
 * bizname / am_name (via the snapshot) for the response.
 */
export async function searchFacts(opts: {
  topic_subcategory?: string;
  field_name?: string;
  value_contains?: string;
  topic_category?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: BrainFact[]; total: number }> {
  const sql = getSql();
  if (!sql) return { rows: [], total: 0 };
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const offset = Math.max(0, opts.offset ?? 0);
  // Use string interpolation guarded by parameterized values — Neon
  // template-string queries can't conditionally include WHERE clauses,
  // so we branch on the combination of provided filters.
  const sub = opts.topic_subcategory ?? null;
  const cat = opts.topic_category ?? null;
  const field = opts.field_name ?? null;
  const contains = opts.value_contains
    ? `%${opts.value_contains}%`
    : null;
  try {
    const [rowsResult, countResult] = await Promise.all([
      sql`
        SELECT * FROM beacon_brain_facts
        WHERE confidence_state = 'confirmed'
          AND soft_deleted_at IS NULL
          AND (sunset_at IS NULL OR sunset_at > NOW())
          AND (${cat}::text IS NULL OR topic_category = ${cat})
          AND (${sub}::text IS NULL OR topic_subcategory = ${sub})
          AND (${field}::text IS NULL OR field_name = ${field})
          AND (${contains}::text IS NULL OR value ILIKE ${contains})
        ORDER BY updated_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      sql`
        SELECT COUNT(*)::int AS n FROM beacon_brain_facts
        WHERE confidence_state = 'confirmed'
          AND soft_deleted_at IS NULL
          AND (sunset_at IS NULL OR sunset_at > NOW())
          AND (${cat}::text IS NULL OR topic_category = ${cat})
          AND (${sub}::text IS NULL OR topic_subcategory = ${sub})
          AND (${field}::text IS NULL OR field_name = ${field})
          AND (${contains}::text IS NULL OR value ILIKE ${contains})
      `,
    ]);
    const rows = rowsResult as BrainFact[];
    const total =
      ((countResult as Array<{ n?: number }>)[0]?.n as number) ?? rows.length;
    return { rows, total };
  } catch {
    return { rows: [], total: 0 };
  }
}

/** Counts per topic for the rollup card. */
export async function getCategoryBreakdown(
  customer_id: string,
): Promise<Record<TopicCategory, number>> {
  const sql = getSql();
  if (!sql) {
    return { identity: 0, operational: 0, behavioral: 0, concerns: 0 };
  }
  const rows = (await sql`
    SELECT topic_category, COUNT(*)::int AS n
    FROM beacon_brain_facts
    WHERE customer_id = ${customer_id}
      AND confidence_state = 'confirmed'
      AND soft_deleted_at IS NULL
    GROUP BY topic_category
  `) as Array<{ topic_category: TopicCategory; n: number }>;
  const out: Record<TopicCategory, number> = {
    identity: 0,
    operational: 0,
    behavioral: 0,
    concerns: 0,
  };
  for (const row of rows) out[row.topic_category] = row.n;
  return out;
}
