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
import {
  categoryForSubcategory,
  isNamedField,
  NUMERIC_FIELDS,
  parseLeadingInteger,
} from "./types";
import {
  embedText,
  factEmbeddingText,
  formatVectorLiteral,
  SEMANTIC_DUPLICATE_THRESHOLD,
} from "./embeddings";
import { applyConflictResolution } from "./ranking";

/**
 * Wave 2b — semantic conflict surfaced when an incoming fact's embedding
 * sits too close to an existing same-customer fact's embedding. Caller
 * sees the conflicting fact_id + value + similarity score and can
 * choose to override via `force_semantic_conflict: true` (or fold the
 * new fact into the existing one via 'other').
 */
export class SemanticConflictError extends Error {
  public readonly conflicting_fact_id: string;
  public readonly conflicting_value: string;
  public readonly similarity: number;
  public readonly proposed_value: string;
  constructor(opts: {
    conflicting_fact_id: string;
    conflicting_value: string;
    similarity: number;
    proposed_value: string;
  }) {
    super(
      `semantic conflict: proposed "${opts.proposed_value.slice(0, 60)}" overlaps existing fact ${opts.conflicting_fact_id} ("${opts.conflicting_value.slice(0, 60)}") at similarity ${(opts.similarity * 100).toFixed(0)}%`,
    );
    this.name = "SemanticConflictError";
    this.conflicting_fact_id = opts.conflicting_fact_id;
    this.conflicting_value = opts.conflicting_value;
    this.similarity = opts.similarity;
    this.proposed_value = opts.proposed_value;
  }
}

/**
 * Embed the proposed fact and query the closest existing same-customer
 * fact (any confidence_state, not soft-deleted). Returns the nearest
 * match + cosine similarity. Returns null when:
 *   - VOYAGE_API_KEY missing or embedding call failed
 *   - No existing facts for this customer have embeddings
 */
async function findSemanticNeighbor(
  customer_id: string,
  topic_subcategory: string,
  field_name: string,
  value: string,
): Promise<{
  fact_id: string;
  value: string;
  similarity: number;
  proposed_embedding: number[];
} | null> {
  const sql = getSql();
  if (!sql) return null;

  const embedResult = await embedText(
    factEmbeddingText(topic_subcategory, field_name, value),
  );
  if (!embedResult) return null;

  const vec = formatVectorLiteral(embedResult.embedding);
  const rows = (await sql`
    SELECT fact_id, value, 1 - (embedding <=> ${vec}::vector) AS similarity
    FROM beacon_brain_facts
    WHERE customer_id = ${customer_id}
      AND soft_deleted_at IS NULL
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vec}::vector
    LIMIT 1
  `) as Array<{ fact_id: string; value: string; similarity: number }>;

  if (rows.length === 0) {
    return {
      fact_id: "",
      value: "",
      similarity: 0,
      proposed_embedding: embedResult.embedding,
    };
  }
  return {
    fact_id: rows[0].fact_id,
    value: rows[0].value,
    similarity: rows[0].similarity,
    proposed_embedding: embedResult.embedding,
  };
}

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

  // Wave 1.1 — parse a leading integer into value_numeric for numeric-
  // shaped fields (staff_count, location_count). Other fields stay NULL.
  // Lets managers run "staff_count > 5" queries via searchFacts.
  const valueNumeric: number | null = NUMERIC_FIELDS.has(input.field_name)
    ? parseLeadingInteger(input.value)
    : null;

  // SMART-K4 — validate derived_from points at a SAME-customer fact.
  // The DB FK only checks fact_id global uniqueness; the customer-scope
  // invariant is enforced here so cross-customer parent links never
  // land in the table.
  const derivedFrom: string | null = input.derived_from ?? null;
  if (derivedFrom) {
    const parent = (await sql`
      SELECT customer_id FROM beacon_brain_facts
      WHERE fact_id = ${derivedFrom}::uuid
        AND soft_deleted_at IS NULL
      LIMIT 1
    `) as Array<{ customer_id: string }>;
    if (parent.length === 0) {
      throw new Error(
        `[brain] derived_from ${derivedFrom} not found (or soft-deleted) — cannot link`,
      );
    }
    if (parent[0].customer_id !== input.customer_id) {
      throw new Error(
        `[brain] cross-customer derived_from rejected: parent fact ${derivedFrom} belongs to ${parent[0].customer_id}, not ${input.customer_id}`,
      );
    }
  }

  // Wave 2b — compute embedding upfront so we can both (a) gate inserts
  // on semantic conflict and (b) store the vector in the same INSERT/
  // UPDATE. Soft-fails to null when VOYAGE_API_KEY is missing or the
  // call errors; in that case we skip the conflict check and write
  // without an embedding (caught by the next backfill run).
  const neighbor = await findSemanticNeighbor(
    input.customer_id,
    input.topic_subcategory,
    input.field_name,
    input.value,
  );
  const proposedEmbedding = neighbor?.proposed_embedding ?? null;
  const embeddingLiteral = proposedEmbedding
    ? formatVectorLiteral(proposedEmbedding)
    : null;

  // For named fields, check for an existing row at (customer, sub, field)
  // FIRST — that tells us whether this is a true insert (semantic gate
  // applies) or an existing-row update (gate would always self-flag, so
  // we skip it).
  let existing: BrainFact[] = [];
  if (named && input.field_name !== "other") {
    existing = (await sql`
      SELECT * FROM beacon_brain_facts
      WHERE customer_id = ${input.customer_id}
        AND topic_subcategory = ${input.topic_subcategory}
        AND field_name = ${input.field_name}
        AND soft_deleted_at IS NULL
      LIMIT 1
    `) as BrainFact[];
  }

  // True insert paths: (a) non-named/other field, or (b) named field
  // with no existing row. These get the semantic-conflict gate. Update
  // paths skip it.
  const willInsert =
    !named || input.field_name === "other" || existing.length === 0;

  if (
    willInsert &&
    !input.force_semantic_conflict &&
    neighbor &&
    neighbor.fact_id &&
    neighbor.similarity >= SEMANTIC_DUPLICATE_THRESHOLD
  ) {
    throw new SemanticConflictError({
      conflicting_fact_id: neighbor.fact_id,
      conflicting_value: neighbor.value,
      similarity: neighbor.similarity,
      proposed_value: input.value,
    });
  }

  if (!named || input.field_name === "other") {
    // Insert-only path.
    const rows = (await sql`
      INSERT INTO beacon_brain_facts (
        customer_id, topic_category, topic_subcategory, field_name, value,
        value_numeric,
        confidence_state, source_type, source_ref, owning_am_email,
        confirmed_by_email, confirmed_at, sunset_at, embedding, derived_from
      ) VALUES (
        ${input.customer_id},
        ${input.topic_category},
        ${input.topic_subcategory},
        ${input.field_name},
        ${input.value},
        ${valueNumeric},
        ${confState},
        ${input.source_type},
        ${input.source_ref ?? null},
        ${input.owning_am_email ?? null},
        ${input.confirmed_by_email ?? null},
        ${confTime},
        ${input.sunset_at ?? null},
        ${embeddingLiteral}::vector,
        ${derivedFrom}
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
      // Wave-2: when the caller explicitly forced past a semantic-conflict,
      // run cluster resolution so Beam's read path knows which fact is
      // authoritative. Soft-fail — if it errors, both facts stay
      // authoritative (pre-Wave-2 behavior), which is recoverable but
      // not ideal. Skipped when no real neighbor existed.
      if (
        input.force_semantic_conflict &&
        neighbor &&
        neighbor.fact_id &&
        neighbor.similarity >= SEMANTIC_DUPLICATE_THRESHOLD
      ) {
        await applyConflictResolution({
          new_fact: newRow,
          neighbor_fact_id: neighbor.fact_id,
        });
      }
    }
    return newRow ?? null;
  }

  // Named field path: existing row already fetched above for the
  // semantic-gate decision. Branch on whether we have one.

  if (existing.length === 0) {
    // No existing row — insert as new.
    const rows = (await sql`
      INSERT INTO beacon_brain_facts (
        customer_id, topic_category, topic_subcategory, field_name, value,
        value_numeric,
        confidence_state, source_type, source_ref, owning_am_email,
        confirmed_by_email, confirmed_at, sunset_at, embedding, derived_from
      ) VALUES (
        ${input.customer_id},
        ${input.topic_category},
        ${input.topic_subcategory},
        ${input.field_name},
        ${input.value},
        ${valueNumeric},
        ${confState},
        ${input.source_type},
        ${input.source_ref ?? null},
        ${input.owning_am_email ?? null},
        ${input.confirmed_by_email ?? null},
        ${confTime},
        ${input.sunset_at ?? null},
        ${embeddingLiteral}::vector,
        ${derivedFrom}
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
      // Wave-2 conflict resolution — same gate as the unnamed/other
      // insert path above. Named-field inserts on a fresh tuple can
      // still semantically collide with a different-tuple sibling.
      if (
        input.force_semantic_conflict &&
        neighbor &&
        neighbor.fact_id &&
        neighbor.similarity >= SEMANTIC_DUPLICATE_THRESHOLD
      ) {
        await applyConflictResolution({
          new_fact: newRow,
          neighbor_fact_id: neighbor.fact_id,
        });
      }
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
  // This path is treated as an edit, not a conflict. The semantic gate
  // is intentionally skipped here (it would always self-flag).
  // Re-embed the new value so the stored vector tracks the latest text.
  //
  // SMART-K4 — derived_from is COALESCE-merged: callers that don't pass
  // derived_from in an edit shouldn't accidentally clear an existing
  // parent link. To set it to NULL explicitly, callers can pass null AND
  // we'd need an `unlink` flag — out of scope; defer to direct DB if
  // needed.
  const newVersion = current.current_version + 1;
  const updated = (await sql`
    UPDATE beacon_brain_facts
    SET value = ${input.value},
        value_numeric = ${valueNumeric},
        source_type = ${input.source_type},
        source_ref = ${input.source_ref ?? null},
        current_version = ${newVersion},
        updated_at = NOW(),
        embedding = ${embeddingLiteral}::vector,
        derived_from = COALESCE(${derivedFrom}::uuid, derived_from),
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

/**
 * Read all non-deleted facts for a customer. Used by Beacon AI retrieval +
 * the Brain panel.
 *
 * Wave-2: defaults to authoritative-only (`superseded_by IS NULL`). Set
 * `includeSuperseded: true` for the Validate inbox audit view that wants
 * to render the cluster history.
 */
export async function getFactsForCustomer(
  customer_id: string,
  opts: {
    confirmedOnly?: boolean;
    includeSuperseded?: boolean;
    /**
     * SMART-K2 — when true, also return facts the nightly stale-prune
     * marked stale. Default false: the regular Brain panel + Beam read
     * path skips stale rows so retrieval quality stays high. Audit views
     * (Validate inbox history, /admin/brain/*) set this to true to render
     * the full preserved history.
     */
    includeStale?: boolean;
  } = {},
): Promise<BrainFact[]> {
  const sql = getSql();
  if (!sql) return [];
  const includeSuperseded = opts.includeSuperseded ?? false;
  const includeStale = opts.includeStale ?? false;
  const rows = opts.confirmedOnly
    ? ((await sql`
        SELECT * FROM beacon_brain_facts
        WHERE customer_id = ${customer_id}
          AND confidence_state = 'confirmed'
          AND soft_deleted_at IS NULL
          AND (sunset_at IS NULL OR sunset_at > NOW())
          AND (${includeSuperseded}::boolean = true OR superseded_by IS NULL)
          AND (${includeStale}::boolean = true OR is_stale = false)
        ORDER BY topic_category, topic_subcategory, field_name
      `) as BrainFact[])
    : ((await sql`
        SELECT * FROM beacon_brain_facts
        WHERE customer_id = ${customer_id}
          AND soft_deleted_at IS NULL
          AND (${includeSuperseded}::boolean = true OR superseded_by IS NULL)
          AND (${includeStale}::boolean = true OR is_stale = false)
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
  // Wave 1.1 — numeric range filters for fields with parsed value_numeric
  // (currently staff_count + location_count). Ignored on non-numeric fields
  // because their value_numeric is NULL and the IS NULL clause excludes them.
  value_numeric_gte?: number;
  value_numeric_lte?: number;
  /**
   * SMART-K2 — opt in to include facts the nightly prune marked stale.
   * Default false: cross-book Beam queries (query_brain) skip stale rows.
   * Admin / audit callers (/admin/brain/search) can set this true.
   */
  includeStale?: boolean;
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
  const numGte =
    typeof opts.value_numeric_gte === "number" ? opts.value_numeric_gte : null;
  const numLte =
    typeof opts.value_numeric_lte === "number" ? opts.value_numeric_lte : null;
  const includeStale = opts.includeStale ?? false;
  try {
    const [rowsResult, countResult] = await Promise.all([
      sql`
        SELECT * FROM beacon_brain_facts
        WHERE confidence_state = 'confirmed'
          AND soft_deleted_at IS NULL
          AND (sunset_at IS NULL OR sunset_at > NOW())
          AND superseded_by IS NULL
          AND (${includeStale}::boolean = true OR is_stale = false)
          AND (${cat}::text IS NULL OR topic_category = ${cat})
          AND (${sub}::text IS NULL OR topic_subcategory = ${sub})
          AND (${field}::text IS NULL OR field_name = ${field})
          AND (${contains}::text IS NULL OR value ILIKE ${contains})
          AND (${numGte}::int IS NULL OR value_numeric >= ${numGte})
          AND (${numLte}::int IS NULL OR value_numeric <= ${numLte})
        ORDER BY updated_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      sql`
        SELECT COUNT(*)::int AS n FROM beacon_brain_facts
        WHERE confidence_state = 'confirmed'
          AND soft_deleted_at IS NULL
          AND (sunset_at IS NULL OR sunset_at > NOW())
          AND superseded_by IS NULL
          AND (${includeStale}::boolean = true OR is_stale = false)
          AND (${cat}::text IS NULL OR topic_category = ${cat})
          AND (${sub}::text IS NULL OR topic_subcategory = ${sub})
          AND (${field}::text IS NULL OR field_name = ${field})
          AND (${contains}::text IS NULL OR value ILIKE ${contains})
          AND (${numGte}::int IS NULL OR value_numeric >= ${numGte})
          AND (${numLte}::int IS NULL OR value_numeric <= ${numLte})
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
    return {
      identity: 0,
      operational: 0,
      behavioral: 0,
      concerns: 0,
      relationship: 0,
    };
  }
  const rows = (await sql`
    SELECT topic_category, COUNT(*)::int AS n
    FROM beacon_brain_facts
    WHERE customer_id = ${customer_id}
      AND confidence_state = 'confirmed'
      AND soft_deleted_at IS NULL
      AND superseded_by IS NULL
    GROUP BY topic_category
  `) as Array<{ topic_category: TopicCategory; n: number }>;
  const out: Record<TopicCategory, number> = {
    identity: 0,
    operational: 0,
    behavioral: 0,
    concerns: 0,
    relationship: 0,
  };
  for (const row of rows) out[row.topic_category] = row.n;
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * Wave 1.5 — Validate inbox: candidate triage operations.
 *
 * Candidates are facts with confidence_state='candidate', written by the
 * Haiku notes-extraction cron (source_type='beacon_ai_extracted'). AMs
 * triage them via /admin/brain/validate with four actions:
 *   - confirm:     candidate → confirmed (version log change_reason='confirm')
 *   - editConfirm: value updated + candidate → confirmed ('refine')
 *   - reject:      soft-delete ('reject')
 *   - reclassify:  reject old at (sub_a, field_a) + insert new at (sub_b,
 *                  field_b) with same value, confirmed ('reject' + 'create')
 *
 * All four go through the existing version log so the full audit trail
 * is preserved. Reads via listCandidates() filter to live, non-deleted
 * candidates only.
 * ──────────────────────────────────────────────────────────────────────── */

export interface CandidateRow extends BrainFact {
  /** Hydrated at the API layer from snapshot.am_name (lookup via customer_id). */
  am_name?: string | null;
  /** Hydrated from snapshot.company / customer.bizname. */
  bizname?: string | null;
  /** Verbatim source quote pulled from the version log if available. */
  source_quote?: string | null;
}

/**
 * List all live candidates (non-confirmed, non-deleted) for the Validate
 * inbox. Sorted by customer_id so candidates for the same customer cluster
 * together; the API layer re-sorts by am_name once hydrated from snapshot.
 *
 * `am_emails` (optional) restricts to candidates whose owning_am_email is
 * in the set — used to scope to a single AM's book. Manager view passes
 * nothing and sees everything.
 */
export async function listCandidates(opts: {
  owning_am_emails?: string[];
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: BrainFact[]; total: number }> {
  const sql = getSql();
  if (!sql) return { rows: [], total: 0 };
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const offset = Math.max(0, opts.offset ?? 0);
  const ams =
    opts.owning_am_emails && opts.owning_am_emails.length > 0
      ? opts.owning_am_emails
      : null;
  try {
    const [rowsResult, countResult] = await Promise.all([
      sql`
        SELECT * FROM beacon_brain_facts
        WHERE confidence_state = 'candidate'
          AND soft_deleted_at IS NULL
          AND (${ams}::text[] IS NULL OR owning_am_email = ANY(${ams}))
        ORDER BY customer_id, topic_category, topic_subcategory, field_name, created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      sql`
        SELECT COUNT(*)::int AS n FROM beacon_brain_facts
        WHERE confidence_state = 'candidate'
          AND soft_deleted_at IS NULL
          AND (${ams}::text[] IS NULL OR owning_am_email = ANY(${ams}))
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

/**
 * SMART-K1 — atomically bump citation_count + stamp last_cited_at for a
 * batch of facts. Called fire-and-forget from the hybrid retrieval path
 * in the read_customer_brain + query_brain tools every time facts are
 * presented to Beam.
 *
 * Why batched: every tool invocation surfaces N facts (typically 5-50).
 * One UPDATE with WHERE fact_id = ANY($1::uuid[]) keeps it to a single
 * round-trip instead of N. Filters out malformed ids defensively so a
 * bad cast doesn't poison the whole batch.
 *
 * No version-log row is written — citation activity is operational
 * telemetry, not a curated edit. The version log stays clean for the
 * Validate inbox audit trail.
 *
 * Soft-fails on any error: logs a warning and resolves. A failed citation
 * bump leaves ranking at its prior value, which is the pre-SMART-K1
 * behavior — recoverable, not data loss.
 */
export async function recordCitation(fact_ids: string[]): Promise<void> {
  const sql = getSql();
  if (!sql) return;
  if (!Array.isArray(fact_ids) || fact_ids.length === 0) return;
  const cleaned = fact_ids.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (cleaned.length === 0) return;
  try {
    await sql`
      UPDATE beacon_brain_facts
      SET citation_count = citation_count + 1,
          last_cited_at = NOW()
      WHERE fact_id = ANY(${cleaned}::uuid[])
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[brain] recordCitation failed for ${cleaned.length} fact(s): ${msg}`);
  }
}

/** Look up a single fact by id (any state, any source). */
export async function getFactById(fact_id: string): Promise<BrainFact | null> {
  const sql = getSql();
  if (!sql) return null;
  const rows = (await sql`
    SELECT * FROM beacon_brain_facts WHERE fact_id = ${fact_id} LIMIT 1
  `) as BrainFact[];
  return rows[0] ?? null;
}

/**
 * Get the most recent source_quote for a fact from the version log. The
 * Haiku extractor stores the quote on the version-log row for the initial
 * 'create' so the Validate inbox can show what evidence the candidate is
 * grounded in.
 *
 * Returns null if the version log has no quote (older facts, manual writes).
 */
export async function getSourceQuoteForFact(fact_id: string): Promise<string | null> {
  const sql = getSql();
  if (!sql) return null;
  const rows = (await sql`
    SELECT source_ref FROM beacon_brain_fact_versions
    WHERE fact_id = ${fact_id}
    ORDER BY version ASC
    LIMIT 1
  `) as Array<{ source_ref: string | null }>;
  const first = rows[0]?.source_ref ?? null;
  if (!first) return null;
  // source_ref convention for beacon_ai_extracted candidates:
  //   "note:<am_name>:<entity_id>::quote:<verbatim>"
  // Strip the prefix when present.
  const idx = first.indexOf("::quote:");
  if (idx < 0) return null;
  return first.slice(idx + "::quote:".length);
}

/** Flip a candidate to confirmed. No value change. */
export async function confirmCandidateFact(
  fact_id: string,
  by_email: string,
): Promise<BrainFact | null> {
  const sql = getSql();
  if (!sql) return null;
  const current = await getFactById(fact_id);
  if (!current || current.confidence_state !== "candidate" || current.soft_deleted_at) {
    return null;
  }
  const newVersion = current.current_version + 1;
  const updated = (await sql`
    UPDATE beacon_brain_facts
    SET confidence_state = 'confirmed',
        confirmed_by_email = ${by_email},
        confirmed_at = NOW(),
        current_version = ${newVersion},
        updated_at = NOW()
    WHERE fact_id = ${fact_id}
    RETURNING *
  `) as BrainFact[];
  const row = updated[0];
  if (row) {
    await sql`
      INSERT INTO beacon_brain_fact_versions (
        customer_id, fact_id, version, value, confidence_state,
        source_type, source_ref, prior_value, changed_by_email, change_reason
      ) VALUES (
        ${row.customer_id}, ${row.fact_id}, ${newVersion}, ${row.value},
        ${row.confidence_state}, ${row.source_type}, ${row.source_ref},
        ${current.value}, ${by_email}, 'confirm'
      )
    `;
  }
  return row ?? null;
}

/** Update value AND flip candidate → confirmed. Logged as 'refine'. */
export async function editAndConfirmCandidateFact(
  fact_id: string,
  new_value: string,
  by_email: string,
): Promise<BrainFact | null> {
  const sql = getSql();
  if (!sql) return null;
  if (!new_value || !new_value.trim()) return null;
  const current = await getFactById(fact_id);
  if (!current || current.confidence_state !== "candidate" || current.soft_deleted_at) {
    return null;
  }
  const newVersion = current.current_version + 1;
  const valueNumeric: number | null = NUMERIC_FIELDS.has(current.field_name)
    ? parseLeadingInteger(new_value)
    : null;
  const updated = (await sql`
    UPDATE beacon_brain_facts
    SET value = ${new_value},
        value_numeric = ${valueNumeric},
        confidence_state = 'confirmed',
        confirmed_by_email = ${by_email},
        confirmed_at = NOW(),
        current_version = ${newVersion},
        updated_at = NOW()
    WHERE fact_id = ${fact_id}
    RETURNING *
  `) as BrainFact[];
  const row = updated[0];
  if (row) {
    await sql`
      INSERT INTO beacon_brain_fact_versions (
        customer_id, fact_id, version, value, confidence_state,
        source_type, source_ref, prior_value, changed_by_email, change_reason
      ) VALUES (
        ${row.customer_id}, ${row.fact_id}, ${newVersion}, ${row.value},
        ${row.confidence_state}, ${row.source_type}, ${row.source_ref},
        ${current.value}, ${by_email}, 'refine'
      )
    `;
  }
  return row ?? null;
}

/** Soft-delete a candidate. Logged as 'reject'. */
export async function rejectCandidateFact(
  fact_id: string,
  by_email: string,
): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  const current = await getFactById(fact_id);
  if (!current || current.soft_deleted_at) return false;
  const newVersion = current.current_version + 1;
  await sql`
    UPDATE beacon_brain_facts
    SET soft_deleted_at = NOW(),
        current_version = ${newVersion},
        updated_at = NOW()
    WHERE fact_id = ${fact_id}
  `;
  await sql`
    INSERT INTO beacon_brain_fact_versions (
      customer_id, fact_id, version, value, confidence_state,
      source_type, source_ref, prior_value, changed_by_email, change_reason
    ) VALUES (
      ${current.customer_id}, ${current.fact_id}, ${newVersion}, ${current.value},
      ${current.confidence_state}, ${current.source_type}, ${current.source_ref},
      ${current.value}, ${by_email}, 'reject'
    )
  `;
  return true;
}

/**
 * Reclassify a candidate to a different (category, subcategory, field_name).
 * Rejects the original and inserts a new confirmed fact at the target.
 * Returns the new fact, or null if validation fails.
 */
export async function reclassifyCandidateFact(
  fact_id: string,
  target: {
    topic_category: TopicCategory;
    topic_subcategory: TopicSubcategory;
    field_name: string;
  },
  by_email: string,
): Promise<BrainFact | null> {
  const current = await getFactById(fact_id);
  if (!current || current.confidence_state !== "candidate" || current.soft_deleted_at) {
    return null;
  }
  // Validate target shape before mutating.
  const expectedCategory = categoryForSubcategory(target.topic_subcategory);
  if (target.topic_category !== expectedCategory) return null;
  const validField =
    target.field_name === "other" ||
    isNamedField(target.topic_subcategory, target.field_name);
  if (!validField) return null;

  // Reject the original first.
  const ok = await rejectCandidateFact(fact_id, by_email);
  if (!ok) return null;

  // Insert the new fact at the target location, confirmed.
  return writeBrainFact({
    customer_id: current.customer_id,
    topic_category: target.topic_category,
    topic_subcategory: target.topic_subcategory,
    field_name: target.field_name,
    value: current.value,
    source_type: current.source_type,
    source_ref: current.source_ref ?? undefined,
    owning_am_email: current.owning_am_email ?? undefined,
    confirmed_by_email: by_email,
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * Wave 1.5 quality check — Haiku-extracted candidate reject-rate stats.
 *
 * The product question: are the Haiku extractions any good, or is the
 * prompt too aggressive? Measured by reject rate. Rule of thumb: if more
 * than 30 % of triaged candidates get rejected, the prompt needs
 * tightening.
 *
 * Approach
 * --------
 * For each fact written by the Haiku extractor (source_type
 * 'beacon_ai_extracted', identified by the 'create' row on the version
 * log), we find the LATEST change_reason on the same fact. The latest
 * change_reason encodes the AM's verdict:
 *
 *     change_reason       outcome
 *     ------------------  --------------------
 *     create   (only row) pending  (untriaged)
 *     confirm             confirmed
 *     refine              edit_confirmed
 *     reject              rejected
 *     reclassify          reclassified  (synthesized — see note below)
 *
 * NOTE on reclassification — `reclassifyCandidateFact` actually emits
 * `change_reason='reject'` on the original fact + a brand-new 'create'
 * row on the destination fact. There is no `reclassify` enum value in
 * ChangeReason. Reclassified candidates therefore look like rejects in
 * the version log on the SOURCE row. We keep them in the rejected
 * bucket here (it's the most honest reading: the Haiku put the fact in
 * the wrong slot). If the team wants to split them out later, the
 * source_ref of the new 'create' row points at the original — we can
 * left-join on that to bucket separately.
 *
 * reject_rate = rejected / (confirmed + edit_confirmed + rejected)
 *
 *   - excludes still-pending candidates (they haven't been triaged yet)
 *   - reclassified counts as rejected per the note above
 *
 * Window
 * ------
 * The window applies to the ORIGINAL 'create' timestamp on the version
 * log. A candidate created 6 days ago and rejected today still belongs
 * to the 7d window — what we care about is the cohort of extractions
 * from that period, regardless of when triage happened.
 *
 * Pass `windowDays: undefined` (or omit) for the all-time view.
 * ──────────────────────────────────────────────────────────────────────── */

export interface CandidateOutcomeStats {
  total: number;
  confirmed: number;
  rejected: number;
  edit_confirmed: number;
  reclassified: number;
  pending: number;
  /** rejected / (confirmed + edit_confirmed + rejected). 0 if no triaged. */
  reject_rate: number;
}

export interface CandidateOutcomeStatsByAm extends CandidateOutcomeStats {
  owning_am_email: string;
}

/**
 * Per-fact latest-change CTE. Used by both helpers.
 *
 *   - `creates`: every Haiku-extracted fact's initial 'create' version row
 *                (one row per fact). Captures the window via `changed_at`.
 *   - `latest`:  the most recent version row per fact_id. Its change_reason
 *                is the verdict; tied creates are mapped to 'pending'.
 *
 * Reclassified is currently always 0 (no reclassify ChangeReason); the
 * column is kept for future expansion if we add the enum value.
 */
export async function getCandidateOutcomeStats(opts: {
  windowDays?: number;
  amEmail?: string;
} = {}): Promise<CandidateOutcomeStats> {
  const sql = getSql();
  const empty: CandidateOutcomeStats = {
    total: 0,
    confirmed: 0,
    rejected: 0,
    edit_confirmed: 0,
    reclassified: 0,
    pending: 0,
    reject_rate: 0,
  };
  if (!sql) return empty;

  const windowDays =
    typeof opts.windowDays === "number" && Number.isFinite(opts.windowDays)
      ? Math.max(1, Math.floor(opts.windowDays))
      : null;
  const amEmail = opts.amEmail ?? null;

  try {
    const rows = (await sql`
      WITH creates AS (
        SELECT v.fact_id, v.changed_at AS created_at, f.owning_am_email
        FROM beacon_brain_fact_versions v
        JOIN beacon_brain_facts f ON f.fact_id = v.fact_id
        WHERE v.change_reason = 'create'
          AND v.source_type = 'beacon_ai_extracted'
          AND (${windowDays}::int IS NULL
               OR v.changed_at >= NOW() - (${windowDays} || ' days')::interval)
          AND (${amEmail}::text IS NULL OR f.owning_am_email = ${amEmail})
      ),
      latest AS (
        -- Take the latest AM TRIAGE row only (confirm | refine | reject).
        -- 'edit' rows can be emitted by the Haiku cron when it re-extracts
        -- the same tuple with a new value — that's not an AM verdict and
        -- shouldn't bucket as triaged. Facts with zero triage rows fall
        -- out of this join and land as 'pending' in the LEFT JOIN below.
        SELECT DISTINCT ON (v.fact_id)
          v.fact_id, v.change_reason
        FROM beacon_brain_fact_versions v
        JOIN creates c ON c.fact_id = v.fact_id
        WHERE v.change_reason IN ('confirm', 'refine', 'reject')
        ORDER BY v.fact_id, v.version DESC
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE l.change_reason = 'confirm')::int AS confirmed,
        COUNT(*) FILTER (WHERE l.change_reason = 'reject')::int AS rejected,
        COUNT(*) FILTER (WHERE l.change_reason = 'refine')::int AS edit_confirmed,
        0::int AS reclassified,
        COUNT(*) FILTER (WHERE l.change_reason IS NULL)::int AS pending
      FROM creates c
      LEFT JOIN latest l ON l.fact_id = c.fact_id
    `) as Array<{
      total: number;
      confirmed: number;
      rejected: number;
      edit_confirmed: number;
      reclassified: number;
      pending: number;
    }>;

    const r = rows[0] ?? empty;
    const triaged = r.confirmed + r.edit_confirmed + r.rejected;
    const reject_rate = triaged > 0 ? r.rejected / triaged : 0;
    return { ...r, reject_rate };
  } catch (err) {
    console.error("[brain] getCandidateOutcomeStats failed", err);
    return empty;
  }
}

/**
 * Same outcome bucketing as getCandidateOutcomeStats, grouped by
 * owning_am_email. Rows with no AM (system-owned) bucket under '__none__'.
 */
export async function getCandidateOutcomeStatsByAm(opts: {
  windowDays?: number;
} = {}): Promise<CandidateOutcomeStatsByAm[]> {
  const sql = getSql();
  if (!sql) return [];

  const windowDays =
    typeof opts.windowDays === "number" && Number.isFinite(opts.windowDays)
      ? Math.max(1, Math.floor(opts.windowDays))
      : null;

  try {
    const rows = (await sql`
      WITH creates AS (
        SELECT v.fact_id, v.changed_at AS created_at,
               COALESCE(f.owning_am_email, '__none__') AS owning_am_email
        FROM beacon_brain_fact_versions v
        JOIN beacon_brain_facts f ON f.fact_id = v.fact_id
        WHERE v.change_reason = 'create'
          AND v.source_type = 'beacon_ai_extracted'
          AND (${windowDays}::int IS NULL
               OR v.changed_at >= NOW() - (${windowDays} || ' days')::interval)
      ),
      latest AS (
        -- Take the latest AM TRIAGE row only (confirm | refine | reject).
        -- 'edit' rows can be emitted by the Haiku cron when it re-extracts
        -- the same tuple with a new value — that's not an AM verdict and
        -- shouldn't bucket as triaged. Facts with zero triage rows fall
        -- out of this join and land as 'pending' in the LEFT JOIN below.
        SELECT DISTINCT ON (v.fact_id)
          v.fact_id, v.change_reason
        FROM beacon_brain_fact_versions v
        JOIN creates c ON c.fact_id = v.fact_id
        WHERE v.change_reason IN ('confirm', 'refine', 'reject')
        ORDER BY v.fact_id, v.version DESC
      )
      SELECT
        c.owning_am_email,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE l.change_reason = 'confirm')::int AS confirmed,
        COUNT(*) FILTER (WHERE l.change_reason = 'reject')::int AS rejected,
        COUNT(*) FILTER (WHERE l.change_reason = 'refine')::int AS edit_confirmed,
        0::int AS reclassified,
        COUNT(*) FILTER (WHERE l.change_reason IS NULL)::int AS pending
      FROM creates c
      LEFT JOIN latest l ON l.fact_id = c.fact_id
      GROUP BY c.owning_am_email
      ORDER BY total DESC
    `) as Array<{
      owning_am_email: string;
      total: number;
      confirmed: number;
      rejected: number;
      edit_confirmed: number;
      reclassified: number;
      pending: number;
    }>;

    return rows.map((r) => {
      const triaged = r.confirmed + r.edit_confirmed + r.rejected;
      const reject_rate = triaged > 0 ? r.rejected / triaged : 0;
      return { ...r, reject_rate };
    });
  } catch (err) {
    console.error("[brain] getCandidateOutcomeStatsByAm failed", err);
    return [];
  }
}
