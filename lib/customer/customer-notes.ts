import { getSql } from "./postgres";

/**
 * Phase 18.B: per-AM private notes on customers.
 *
 * Notes are keyed on (am_name, entity_id). Self-heals via
 * ensureNotesSchema() — CREATE TABLE IF NOT EXISTS runs once per cold start,
 * gated by the _notesReady cached boolean. Mirrors the lazy-migration pattern
 * used by lib/pinned-customers.ts (Phase 18.A).
 */

export type CustomerNote = {
  entity_id: string;
  note: string;
  updated_at: string;
};

let _notesReady = false;

async function ensureNotesSchema(): Promise<boolean> {
  if (_notesReady) return true;
  const sql = getSql();
  if (!sql) return false;
  await sql`
    CREATE TABLE IF NOT EXISTS customer_notes (
      am_name TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      customer_id TEXT,
      bizname TEXT,
      note TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (am_name, entity_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_customer_notes_am ON customer_notes(am_name)`;
  _notesReady = true;
  return true;
}

/** Read the saved note for (am_name, entity_id), or null if none. */
export async function getNote(
  amName: string,
  entityId: string,
): Promise<CustomerNote | null> {
  const ready = await ensureNotesSchema();
  if (!ready) return null;
  const sql = getSql();
  if (!sql) return null;
  const rows = await sql`
    SELECT entity_id, note, updated_at
    FROM customer_notes
    WHERE am_name = ${amName} AND entity_id = ${entityId}
    LIMIT 1
  `;
  const row = (rows as Array<{
    entity_id: string;
    note: string;
    updated_at: string | Date;
  }>)[0];
  if (!row) return null;
  return {
    entity_id: row.entity_id,
    note: row.note,
    updated_at:
      typeof row.updated_at === "string"
        ? row.updated_at
        : row.updated_at.toISOString(),
  };
}

/**
 * Upsert the note for (am_name, entity_id). Always bumps updated_at.
 * customer_id and bizname are only filled in if not already set, so old
 * metadata is preserved across re-saves where the UI may not pass them.
 */
export async function upsertNote(
  amName: string,
  entityId: string,
  note: string,
  meta: { customer_id?: string | null; bizname?: string | null },
): Promise<CustomerNote> {
  const ready = await ensureNotesSchema();
  if (!ready) {
    throw new Error(
      "[customer-notes] POSTGRES_URL not configured — cannot persist note",
    );
  }
  const sql = getSql();
  if (!sql) {
    throw new Error(
      "[customer-notes] POSTGRES_URL not configured — cannot persist note",
    );
  }
  const rows = await sql`
    INSERT INTO customer_notes (
      am_name, entity_id, customer_id, bizname, note, updated_at
    )
    VALUES (
      ${amName},
      ${entityId},
      ${meta.customer_id ?? null},
      ${meta.bizname ?? null},
      ${note},
      NOW()
    )
    ON CONFLICT (am_name, entity_id)
    DO UPDATE SET
      note = EXCLUDED.note,
      updated_at = NOW(),
      customer_id = COALESCE(customer_notes.customer_id, EXCLUDED.customer_id),
      bizname = COALESCE(customer_notes.bizname, EXCLUDED.bizname)
    RETURNING entity_id, note, updated_at
  `;
  const row = (rows as Array<{
    entity_id: string;
    note: string;
    updated_at: string | Date;
  }>)[0];
  return {
    entity_id: row.entity_id,
    note: row.note,
    updated_at:
      typeof row.updated_at === "string"
        ? row.updated_at
        : row.updated_at.toISOString(),
  };
}
