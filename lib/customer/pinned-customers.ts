import { getSql } from "./postgres";

/**
 * Phase 18.A: per-AM pinned customers.
 *
 * Pinned set is keyed on (am_name, entity_id). Self-heals via
 * ensurePinnedSchema() — CREATE TABLE IF NOT EXISTS runs once per cold start,
 * gated by the _pinnedReady cached boolean. Mirrors the lazy-migration pattern
 * used for am_actions column ALTERs elsewhere in this codebase, but cached so
 * we don't re-issue DDL on every request.
 */

export type PinnedCustomer = {
  entity_id: string;
  customer_id: string | null;
  bizname: string | null;
  pinned_at: string;
};

let _pinnedReady = false;

async function ensurePinnedSchema(): Promise<boolean> {
  if (_pinnedReady) return true;
  const sql = getSql();
  if (!sql) return false;
  await sql`
    CREATE TABLE IF NOT EXISTS pinned_customers (
      am_name TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      customer_id TEXT,
      bizname TEXT,
      pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (am_name, entity_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_pinned_customers_am ON pinned_customers(am_name)`;
  _pinnedReady = true;
  return true;
}

/** List all pinned customers for an AM, most recent first. */
export async function listPinned(amName: string): Promise<PinnedCustomer[]> {
  const ready = await ensurePinnedSchema();
  if (!ready) return [];
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    SELECT entity_id, customer_id, bizname, pinned_at
    FROM pinned_customers
    WHERE am_name = ${amName}
    ORDER BY pinned_at DESC
  `;
  return (rows as Array<{
    entity_id: string;
    customer_id: string | null;
    bizname: string | null;
    pinned_at: string | Date;
  }>).map((r) => ({
    entity_id: r.entity_id,
    customer_id: r.customer_id ?? null,
    bizname: r.bizname ?? null,
    pinned_at:
      typeof r.pinned_at === "string"
        ? r.pinned_at
        : r.pinned_at.toISOString(),
  }));
}

/** True if a given (am_name, entity_id) is pinned. */
export async function isPinned(
  amName: string,
  entityId: string
): Promise<boolean> {
  const ready = await ensurePinnedSchema();
  if (!ready) return false;
  const sql = getSql();
  if (!sql) return false;
  const rows = await sql`
    SELECT 1 FROM pinned_customers
    WHERE am_name = ${amName} AND entity_id = ${entityId}
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Toggle pin state for a customer under an AM.
 * If the row already exists, delete it (unpin).
 * Otherwise insert it (pin) with optional customer_id + bizname for display.
 */
export async function togglePinned(
  amName: string,
  entityId: string,
  meta: { customer_id?: string | null; bizname?: string | null }
): Promise<{ pinned: boolean }> {
  const ready = await ensurePinnedSchema();
  if (!ready) {
    throw new Error(
      "[pinned-customers] POSTGRES_URL not configured — cannot persist pin state"
    );
  }
  const sql = getSql();
  if (!sql) {
    throw new Error(
      "[pinned-customers] POSTGRES_URL not configured — cannot persist pin state"
    );
  }
  const existing = await sql`
    SELECT 1 FROM pinned_customers
    WHERE am_name = ${amName} AND entity_id = ${entityId}
    LIMIT 1
  `;
  if (existing.length > 0) {
    await sql`
      DELETE FROM pinned_customers
      WHERE am_name = ${amName} AND entity_id = ${entityId}
    `;
    return { pinned: false };
  }
  await sql`
    INSERT INTO pinned_customers (am_name, entity_id, customer_id, bizname)
    VALUES (
      ${amName},
      ${entityId},
      ${meta.customer_id ?? null},
      ${meta.bizname ?? null}
    )
  `;
  return { pinned: true };
}
