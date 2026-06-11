/**
 * Beacon Keeper — META-A2 BaseSheet bootstrap module.
 *
 * Proactively seeds the Keeper with high-confidence BaseSheet facts when
 * a new entity_id is detected by Stage A's diff (G3). Compounds with
 * META-A1 (on-demand fallback tool) — A2 ensures Beam never has to call
 * A1 for already-bootstrapped customers.
 *
 * Mapping rules (see `mapBaseSheetRowToFacts`):
 *   - identity/sold_by/sold_by_ae         ← ae_name
 *   - identity/sold_by/sold_at            ← ob_date (when present + not "N/A")
 *   - operational/contract/mrr_amount     ← total_monthly_revenue (BaseSheet)
 *
 * NOT written here (intentionally):
 *   - current_am / current_ae / current_sp / current_pod are DERIVED
 *     fields (see DERIVED_ASSIGNMENT_FIELDS in types.ts). They're
 *     resolved at retrieval time from the snapshot, never persisted to
 *     beacon_brain_facts — writeBrainFact would treat them as 'other'
 *     and insert a new row on every call, blowing up idempotency.
 *   - phone / app_email — already surfaced from snapshot in the Brain
 *     panel via DERIVED_ASSIGNMENT_FIELDS pattern; no fact-store value.
 *
 * Source-of-truth note: the SAME mapping must be used by META-A1's
 * on-demand fallback tool. A1 should `import { mapBaseSheetRowToFacts }
 * from './metabase-bootstrap'` rather than duplicate it. The function is
 * pure — given a row + customer_id, it returns the list of write inputs
 * with no side effects, so it's safely reusable across batch and per-call
 * paths.
 *
 * Idempotency: writeBrainFact short-circuits when (customer_id,
 * subcategory, field_name) already exists with the same value (semantic-
 * conflict gate + named-field upsert). We additionally pre-filter via
 * `findExistingNamedFacts` to skip work for known-confirmed rows — this
 * keeps the batch fast on re-runs (e.g., the manual backfill against all
 * 900 customers) and avoids wasted Voyage embedding calls.
 */

import { fetchBaseSheet } from "../customer/metabase";
import { readLatestSnapshotV2, getSql } from "../customer/postgres";
import type { BaseSheetRow } from "../customer/types";
import { writeBrainFact } from "./repo";
import type { BrainFactWrite } from "./types";

type SqlClient = ReturnType<typeof getSql>;

const SYSTEM_EMAIL = "system+bootstrap-basesheet@beacon.zoca";

export interface BootstrapKeeperResult {
  entities_processed: number;
  entities_skipped: number;
  facts_written: number;
  facts_skipped_idempotent: number;
  facts_failed: number;
  errors: string[];
}

/**
 * Pure mapping function — shared with META-A1's on-demand tool.
 *
 * Given a BaseSheet row + the resolved Chargebee customer_id, produce
 * the list of BrainFactWrite inputs that bootstrap the Keeper for that
 * customer. Skips empty / sentinel ("N/A") values silently.
 *
 * The function is intentionally pure (no DB, no network) so A1 can call
 * it with a single-row payload without spinning up the batch infra.
 */
export function mapBaseSheetRowToFacts(
  row: BaseSheetRow,
  customer_id: string,
): BrainFactWrite[] {
  if (!customer_id) return [];
  const writes: BrainFactWrite[] = [];

  const ae = (row.ae_name || "").trim();
  if (ae) {
    writes.push({
      customer_id,
      topic_category: "identity",
      topic_subcategory: "sold_by",
      field_name: "sold_by_ae",
      value: ae,
      source_type: "basesheet",
      source_ref: row.entity_id || null,
      owning_am_email: null,
      confirmed_by_email: SYSTEM_EMAIL,
    });
  }

  const ob = (row.ob_date || "").trim();
  if (ob && ob.toUpperCase() !== "N/A") {
    writes.push({
      customer_id,
      topic_category: "identity",
      topic_subcategory: "sold_by",
      field_name: "sold_at",
      value: ob,
      source_type: "basesheet",
      source_ref: row.entity_id || null,
      owning_am_email: null,
      confirmed_by_email: SYSTEM_EMAIL,
    });
  }

  const mrr = (row.total_monthly_revenue || "").trim();
  if (mrr) {
    writes.push({
      customer_id,
      topic_category: "operational",
      topic_subcategory: "contract",
      field_name: "mrr_amount",
      value: `${mrr} (BaseSheet)`,
      source_type: "basesheet",
      source_ref: row.entity_id || null,
      owning_am_email: null,
      confirmed_by_email: SYSTEM_EMAIL,
    });
  }

  return writes;
}

/**
 * Fast idempotency pre-check. Returns the set of (subcategory|field) keys
 * already present for this customer so we can skip the writeBrainFact
 * pipeline entirely for rows that would no-op. Cuts the Voyage embedding
 * cost on re-runs of a clean book down to zero.
 *
 * Returns an empty set when:
 *   - Postgres isn't configured
 *   - No facts exist for this customer yet (every input is a true insert)
 */
async function findExistingNamedFacts(
  sql: SqlClient,
  customer_id: string,
): Promise<Set<string>> {
  if (!sql) return new Set();
  const rows = (await sql`
    SELECT topic_subcategory, field_name
    FROM beacon_brain_facts
    WHERE customer_id = ${customer_id}
      AND soft_deleted_at IS NULL
      AND field_name <> 'other'
  `) as Array<{ topic_subcategory: string; field_name: string }>;
  const set = new Set<string>();
  for (const r of rows) set.add(`${r.topic_subcategory}|${r.field_name}`);
  return set;
}

/**
 * Bootstrap Keeper facts for a batch of entity_ids.
 *
 * Pipeline:
 *   1. fetchBaseSheet() once — single network round-trip for the whole batch.
 *   2. Read latest snapshot to resolve entity_id → customer_id when
 *      BaseSheet's customer_id is empty (rare — BaseSheet ships
 *      customer_id directly for all live subs).
 *   3. For each entity_id, find the BaseSheet row, pre-filter against
 *      existing facts, write the remaining facts via writeBrainFact.
 *   4. Soft-fail per entity_id and per fact — never throw out of the batch.
 *
 * Returns aggregate counters + a per-entity error list (truncated) so
 * callers can log the result and decide whether to alert.
 */
export async function bootstrapKeeperForEntities(
  entityIds: string[],
): Promise<BootstrapKeeperResult> {
  const result: BootstrapKeeperResult = {
    entities_processed: 0,
    entities_skipped: 0,
    facts_written: 0,
    facts_skipped_idempotent: 0,
    facts_failed: 0,
    errors: [],
  };

  const unique = Array.from(
    new Set(entityIds.map((e) => (e || "").trim()).filter(Boolean)),
  );
  if (unique.length === 0) return result;

  // 1. Pull BaseSheet once for the whole batch.
  let baseSheet: Awaited<ReturnType<typeof fetchBaseSheet>>;
  try {
    baseSheet = await fetchBaseSheet();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`fetchBaseSheet failed: ${msg.slice(0, 200)}`);
    return result;
  }

  // 2. Snapshot fallback for entity_id → customer_id resolution.
  let snapshotByEntityId: Map<string, string> = new Map();
  try {
    const snap = await readLatestSnapshotV2();
    if (snap?.customers) {
      for (const c of snap.customers) {
        const eid = (c.entity_id || "").trim();
        const cid = (c.customer_id || "").trim();
        if (eid && cid) snapshotByEntityId.set(eid, cid);
      }
    }
  } catch (e) {
    // Non-fatal — BaseSheet customer_id is the primary path.
    console.warn(
      "[keeper-bootstrap] snapshot read failed, falling back to basesheet only:",
      e instanceof Error ? e.message : String(e),
    );
  }

  const sql = getSql();

  for (const eid of unique) {
    const row = baseSheet.byEntityId[eid];
    if (!row) {
      result.entities_skipped++;
      result.errors.push(`${eid}: no BaseSheet row found`);
      continue;
    }
    const customer_id =
      (row.customer_id || "").trim() || snapshotByEntityId.get(eid) || "";
    if (!customer_id) {
      result.entities_skipped++;
      result.errors.push(`${eid}: no customer_id (BaseSheet + snapshot empty)`);
      continue;
    }

    const proposed = mapBaseSheetRowToFacts(row, customer_id);
    if (proposed.length === 0) {
      result.entities_processed++;
      continue;
    }

    // Idempotency pre-filter: drop writes whose (subcategory, field) slot
    // is already occupied by a non-soft-deleted fact. Avoids Voyage calls
    // and write-path conflict checks on re-runs.
    let existingKeys: Set<string>;
    try {
      existingKeys = await findExistingNamedFacts(sql, customer_id);
    } catch (e) {
      // If the idempotency probe itself errors, fall through to the write
      // path — writeBrainFact's own conflict logic will catch dupes,
      // we'll just spend an extra Voyage call per fact.
      console.warn(
        "[keeper-bootstrap] existing-facts probe failed:",
        e instanceof Error ? e.message : String(e),
      );
      existingKeys = new Set();
    }

    for (const w of proposed) {
      const slotKey = `${w.topic_subcategory}|${w.field_name}`;
      if (existingKeys.has(slotKey)) {
        result.facts_skipped_idempotent++;
        continue;
      }
      try {
        const written = await writeBrainFact(w);
        if (written) result.facts_written++;
        else result.facts_failed++;
      } catch (e) {
        result.facts_failed++;
        const msg = e instanceof Error ? e.message : String(e);
        // SemanticConflictError is a real idempotency signal (same fact,
        // semantically equivalent value) — count it as skipped, not failed.
        if (msg.startsWith("semantic conflict")) {
          result.facts_failed--;
          result.facts_skipped_idempotent++;
          continue;
        }
        result.errors.push(
          `${eid} ${w.topic_subcategory}/${w.field_name}: ${msg.slice(0, 160)}`,
        );
      }
    }
    result.entities_processed++;
  }

  // Cap the error list to keep the response payload small.
  if (result.errors.length > 50) {
    const overflow = result.errors.length - 50;
    result.errors = result.errors.slice(0, 50);
    result.errors.push(`…and ${overflow} more error(s) truncated`);
  }

  return result;
}

/**
 * Identify the union of active entity_ids across the latest snapshot.
 *
 * Used by the admin backfill endpoint when `all_active=true` to pull the
 * entire 900-customer book in one shot. Snapshot is the canonical source
 * of "active book" — BaseSheet alone includes churned rows we don't want
 * to bootstrap.
 */
export async function listActiveEntityIdsFromSnapshot(): Promise<string[]> {
  const snap = await readLatestSnapshotV2();
  if (!snap?.customers) return [];
  const ids = new Set<string>();
  for (const c of snap.customers) {
    const eid = (c.entity_id || "").trim();
    if (eid) ids.add(eid);
  }
  return Array.from(ids);
}
