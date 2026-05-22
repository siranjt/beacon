import { getSql } from "./postgres";

/**
 * Phase 19: per-AM customer snooze.
 *
 * AMs can put a customer on a temporary ignore list for N days. Snoozed
 * customers are hidden from default triage filters and surfaced only on the
 * dedicated 'Snoozed' filter. Snooze rows expire by timestamp — no cron is
 * required; `listActiveSnoozes` filters on `snoozed_until > NOW()`.
 *
 * Self-heals via ensureSnoozeSchema() — CREATE TABLE IF NOT EXISTS runs once
 * per cold start, gated by the _snoozeReady cached boolean. Mirrors the
 * pattern in lib/pinned-customers.ts and lib/customer-notes.ts.
 */

export type SnoozedCustomer = {
  entity_id: string;
  customer_id: string | null;
  bizname: string | null;
  snoozed_until: string; // ISO timestamp
  snoozed_at: string;
  reason: string | null;
};

let _snoozeReady = false;

async function ensureSnoozeSchema(): Promise<boolean> {
  if (_snoozeReady) return true;
  const sql = getSql();
  if (!sql) return false;
  await sql`
    CREATE TABLE IF NOT EXISTS snooze_tracking (
      am_name TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      customer_id TEXT,
      bizname TEXT,
      snoozed_until TIMESTAMPTZ NOT NULL,
      snoozed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reason TEXT,
      PRIMARY KEY (am_name, entity_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_snooze_tracking_am ON snooze_tracking(am_name)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_snooze_tracking_until ON snooze_tracking(snoozed_until)`;
  _snoozeReady = true;
  return true;
}

function toIso(v: string | Date): string {
  return typeof v === "string" ? v : v.toISOString();
}

/** Returns all CURRENTLY active snoozes (snoozed_until > NOW) for an AM. */
export async function listActiveSnoozes(amName: string): Promise<SnoozedCustomer[]> {
  const ready = await ensureSnoozeSchema();
  if (!ready) return [];
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    SELECT entity_id, customer_id, bizname, snoozed_until, snoozed_at, reason
    FROM snooze_tracking
    WHERE am_name = ${amName} AND snoozed_until > NOW()
    ORDER BY snoozed_until ASC
  `;
  return (rows as Array<{
    entity_id: string;
    customer_id: string | null;
    bizname: string | null;
    snoozed_until: string | Date;
    snoozed_at: string | Date;
    reason: string | null;
  }>).map((r) => ({
    entity_id: r.entity_id,
    customer_id: r.customer_id ?? null,
    bizname: r.bizname ?? null,
    snoozed_until: toIso(r.snoozed_until),
    snoozed_at: toIso(r.snoozed_at),
    reason: r.reason ?? null,
  }));
}

/**
 * Snooze a customer for N days (1..365). Upserts on (am_name, entity_id).
 * Returns the resulting row so the caller can show the new "Snoozed until …"
 * label immediately.
 */
export async function snoozeCustomer(
  amName: string,
  entityId: string,
  days: number,
  meta: { customer_id?: string | null; bizname?: string | null; reason?: string | null },
): Promise<SnoozedCustomer> {
  const ready = await ensureSnoozeSchema();
  if (!ready) {
    throw new Error(
      "[snooze] POSTGRES_URL not configured — cannot persist snooze state",
    );
  }
  const sql = getSql();
  if (!sql) {
    throw new Error(
      "[snooze] POSTGRES_URL not configured — cannot persist snooze state",
    );
  }
  // Compute snoozed_until in JS to avoid timezone surprises across regions.
  const untilIso = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await sql`
    INSERT INTO snooze_tracking (
      am_name, entity_id, customer_id, bizname, snoozed_until, snoozed_at, reason
    ) VALUES (
      ${amName},
      ${entityId},
      ${meta.customer_id ?? null},
      ${meta.bizname ?? null},
      ${untilIso},
      NOW(),
      ${meta.reason ?? null}
    )
    ON CONFLICT (am_name, entity_id) DO UPDATE SET
      snoozed_until = EXCLUDED.snoozed_until,
      snoozed_at = NOW(),
      reason = EXCLUDED.reason,
      customer_id = COALESCE(snooze_tracking.customer_id, EXCLUDED.customer_id),
      bizname = COALESCE(snooze_tracking.bizname, EXCLUDED.bizname)
    RETURNING entity_id, customer_id, bizname, snoozed_until, snoozed_at, reason
  `;
  const r = rows[0] as {
    entity_id: string;
    customer_id: string | null;
    bizname: string | null;
    snoozed_until: string | Date;
    snoozed_at: string | Date;
    reason: string | null;
  };
  return {
    entity_id: r.entity_id,
    customer_id: r.customer_id ?? null,
    bizname: r.bizname ?? null,
    snoozed_until: toIso(r.snoozed_until),
    snoozed_at: toIso(r.snoozed_at),
    reason: r.reason ?? null,
  };
}

/** Remove a snooze row (un-snooze) for (am, entity). Idempotent. */
export async function unsnoozeCustomer(amName: string, entityId: string): Promise<void> {
  const ready = await ensureSnoozeSchema();
  if (!ready) {
    throw new Error(
      "[snooze] POSTGRES_URL not configured — cannot persist snooze state",
    );
  }
  const sql = getSql();
  if (!sql) {
    throw new Error(
      "[snooze] POSTGRES_URL not configured — cannot persist snooze state",
    );
  }
  await sql`
    DELETE FROM snooze_tracking
    WHERE am_name = ${amName} AND entity_id = ${entityId}
  `;
}
