/**
 * META-A4 — Weekly Metabase enrichment cron.
 *
 * Some Metabase fields change slowly enough that fetching them daily is
 * wasteful but never fetching them silently rots Keeper (e.g. a salon
 * adds nail services, a barbershop reclassifies as a med-spa). This
 * module pulls a tight set of slow-changing fields once a week, maps
 * each to its canonical Keeper subcategory/field, and writes the result
 * via writeBrainFact() with strict idempotency.
 *
 * Design choices
 * --------------
 *   - Pure Metabase + Postgres + Keeper writes — ZERO LLM calls. The
 *     cron's cost envelope is literally one CSV download (~1MB) + N
 *     small writeBrainFact() round-trips. Safe to schedule weekly.
 *
 *   - Fact source_type = "basesheet" (high-trust SoR). Each fact lands
 *     as 'confirmed' (auto-confirmed by SYSTEM_EMAIL) — matching the
 *     bootstrap pattern. AMs can edit/refine via the Brain panel if
 *     wrong; the version log captures the change.
 *
 *   - Idempotency: writeBrainFact short-circuits on same-value writes
 *     for named fields. For "other" rows we pre-check via getSql() to
 *     skip identical values (mirrors extract-from-notes pattern).
 *
 *   - Per-customer + per-field soft-fail: one malformed row never kills
 *     the run. Errors accumulate on the result object and surface in
 *     the cron response + Slack alert if error rate > 5%.
 *
 * Source fields actually shipped (Wave 1)
 * ---------------------------------------
 * All three come from the lean BaseSheet CSV (already-fetched, no new
 * Metabase question needed):
 *
 *   primary_category            → identity/business_profile/business_type
 *                                 (with updated_primary_category as override)
 *   lead_source                 → identity/sold_by/other  (sentence form)
 *   chrone_zoca_status          → operational/integration/integration_state
 *
 * Considered but NOT shipped (data quality / source gap)
 * ------------------------------------------------------
 *   service_specialty           — no Metabase question carries this field.
 *                                 Notes-extraction (extract-from-notes)
 *                                 already populates it when AMs mention
 *                                 specialties verbatim.
 *   market_segment              — BaseSheet has no urban/suburban marker.
 *                                 Could be derived from GBP city + Census
 *                                 later; out of scope for this cron.
 *   total_locations             — Chargebee customer→entity_ids count is
 *                                 already in the snapshot (multi_location_count).
 *                                 Doesn't need a Keeper write — derived.
 *   staff_count                 — no SoR. AM-entered via notes extraction.
 */

import Papa from "papaparse";
import { METABASE_ENDPOINTS } from "../customer/config";
import { readLatestSnapshotV2 } from "../customer/postgres";
import { getSql } from "../customer/postgres";
import { writeBrainFact, SemanticConflictError } from "./repo";
import type { TopicCategory, TopicSubcategory } from "./types";

/**
 * Auto-confirm under a system identity so the version log has a coherent
 * actor. Mirrors bootstrap.ts SYSTEM_EMAIL convention.
 */
const SYSTEM_EMAIL = "system+enrichment@beacon.zoca";

/** One slow-changing field we map from BaseSheet to Keeper. */
interface EnrichmentFieldDef {
  /** Display name for logs + admin status page. */
  label: string;
  /** Keeper subcategory the value lands under. */
  topic_subcategory: TopicSubcategory;
  /** Keeper category (derived; included for clarity / type safety). */
  topic_category: TopicCategory;
  /**
   * Named field on the subcategory OR "other". When "other", the value
   * is written as a complete short sentence and idempotency-checked by
   * exact-value match.
   */
  field_name: string;
  /**
   * Given the row from BaseSheet, return the value to write, or null
   * to skip. Pure function — no side effects. Trim + sanity-check
   * here; writeBrainFact() trusts the caller.
   */
  extract(row: Record<string, string>): string | null;
}

/** Raw BaseSheet shape relevant to enrichment (only the fields we read). */
interface BaseSheetEnrichmentRow {
  customer_id: string;
  entity_id: string;
  bizname: string;
  primary_category: string;
  updated_primary_category: string;
  lead_source: string;
  chrone_zoca_status: string;
}

/** Result envelope returned to the cron route. */
export interface EnrichmentResult {
  started_at: string;
  finished_at: string;
  customers_in_snapshot: number;
  customers_in_basesheet: number;
  customers_processed: number;
  customers_skipped: number;
  facts_written: number;
  facts_refined: number;
  facts_unchanged: number;
  facts_failed: number;
  errors: string[];
  /** Per-field tallies, useful for the admin status page. */
  per_field: Record<
    string,
    {
      label: string;
      written: number;
      refined: number;
      unchanged: number;
      failed: number;
    }
  >;
}

/**
 * Canonical mapping table. Adding a new slow-changing field is one entry
 * here + (if needed) a CSV column — no other plumbing required.
 *
 * Selection criteria for "slow-changing":
 *   1. SoR is BaseSheet or a public Metabase question (no LLM needed).
 *   2. Changes < 1x/month for ~95% of customers.
 *   3. Has a clean Keeper landing slot (subcategory + field_name).
 */
export const ENRICHMENT_FIELDS: readonly EnrichmentFieldDef[] = [
  {
    label: "business_type",
    topic_subcategory: "business_profile",
    topic_category: "identity",
    field_name: "other", // No named "business_type" in FIELD_CATALOG — use other.
    extract(row) {
      // Prefer the curated `updated_primary_category` over the raw GBP
      // category when AMs have explicitly corrected the mapping. Both
      // fields exist on the lean BaseSheet (e9005a5c).
      const updated = (row["updated_primary_category"] || "").trim();
      const primary = (row["primary_category"] || "").trim();
      const cat = updated || primary;
      if (!cat) return null;
      return `Business type (GBP primary category): ${cat}`;
    },
  },
  {
    label: "lead_source",
    topic_subcategory: "sold_by",
    topic_category: "identity",
    field_name: "other",
    extract(row) {
      const src = (row["lead_source"] || "").trim();
      if (!src) return null;
      // Skip noise tokens that BaseSheet sometimes emits.
      if (src.toLowerCase() === "n/a" || src.toLowerCase() === "none") {
        return null;
      }
      return `Lead source at acquisition: ${src}`;
    },
  },
  {
    label: "integration_state",
    topic_subcategory: "integration",
    topic_category: "operational",
    field_name: "integration_state",
    extract(row) {
      const v = (row["chrone_zoca_status"] || "").trim();
      if (!v) return null;
      // BaseSheet emits "Chrone" / "Zoca" / "Migrating" — keep verbatim
      // so the field reads consistently across the book.
      return v;
    },
  },
] as const;

/**
 * Fetch + parse the lean BaseSheet CSV. We don't reuse `fetchBaseSheet`
 * from lib/customer/metabase.ts because that helper strips the columns
 * we need here (primary_category, updated_primary_category, lead_source)
 * down to its slim BaseSheetRow shape. A direct CSV read is the simplest
 * way to access the full row without bloating the shared type.
 *
 * Soft-fail on network errors so the cron at least reports cleanly
 * rather than throwing through Vercel's runtime.
 */
async function fetchBaseSheetEnrichmentRows(): Promise<BaseSheetEnrichmentRow[]> {
  const url = METABASE_ENDPOINTS.baseSheet;
  const res = await fetch(url, {
    redirect: "follow",
    cache: "no-store",
    headers: { Accept: "text/csv" },
  });
  if (!res.ok) {
    throw new Error(
      `BaseSheet CSV ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const csv = await res.text();
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  const out: BaseSheetEnrichmentRow[] = [];
  for (const r of parsed.data || []) {
    if (!r || typeof r !== "object") continue;
    const customer_id = (r["customer_id"] || "").trim();
    const entity_id = (r["entity_id"] || "").trim();
    if (!customer_id || !entity_id) continue;
    out.push({
      customer_id,
      entity_id,
      bizname: r["bizname"] || "",
      primary_category: r["primary_category"] || "",
      updated_primary_category: r["updated_primary_category"] || "",
      lead_source: r["lead_source"] || "",
      chrone_zoca_status: r["chrone_zoca_status"] || "",
    });
  }
  return out;
}

/**
 * Check whether a fact with this exact value already exists for the
 * (customer_id, subcategory, field_name) tuple. Used as a fast-path
 * idempotency gate before calling writeBrainFact() — saves an embedding
 * round-trip on the common no-change path. writeBrainFact() ALSO
 * idempotency-checks for named fields, but doing it here gives us a
 * clean "unchanged" tally for the per-field stats.
 *
 * For "other" rows we match on EXACT value (the canonical de-dupe key
 * since multiple "other" entries are allowed per subcategory).
 *
 * Returns:
 *   - { exists: true, same_value: true }   → skip, count as unchanged
 *   - { exists: true, same_value: false }  → will write as refine (named)
 *                                            or as new (other)
 *   - { exists: false, same_value: false } → will write as new
 */
async function probeExistingFact(opts: {
  customer_id: string;
  topic_subcategory: TopicSubcategory;
  field_name: string;
  value: string;
}): Promise<{ exists: boolean; same_value: boolean }> {
  const sql = getSql();
  if (!sql) return { exists: false, same_value: false };
  if (opts.field_name === "other") {
    // For "other", we look for an exact value match — that's the dedupe key.
    const rows = (await sql`
      SELECT fact_id FROM beacon_brain_facts
      WHERE customer_id = ${opts.customer_id}
        AND topic_subcategory = ${opts.topic_subcategory}
        AND field_name = 'other'
        AND value = ${opts.value}
        AND soft_deleted_at IS NULL
      LIMIT 1
    `) as Array<{ fact_id: string }>;
    return { exists: rows.length > 0, same_value: rows.length > 0 };
  }
  // Named field — there's at most one row per (customer, sub, field).
  const rows = (await sql`
    SELECT value FROM beacon_brain_facts
    WHERE customer_id = ${opts.customer_id}
      AND topic_subcategory = ${opts.topic_subcategory}
      AND field_name = ${opts.field_name}
      AND soft_deleted_at IS NULL
    LIMIT 1
  `) as Array<{ value: string }>;
  if (rows.length === 0) return { exists: false, same_value: false };
  return { exists: true, same_value: rows[0].value === opts.value };
}

/**
 * Read every active customer's customer_id from the latest snapshot.
 * The snapshot already filters out churned + excluded entities; we only
 * enrich live customers.
 */
async function listSnapshotCustomerIds(): Promise<Set<string>> {
  const snap = await readLatestSnapshotV2();
  const out = new Set<string>();
  if (!snap || !snap.customers) return out;
  for (const c of snap.customers) {
    const id = (c.customer_id || "").trim();
    if (id) out.add(id);
  }
  return out;
}

/**
 * Process one BaseSheet row against every ENRICHMENT_FIELDS entry.
 * Returns per-field outcomes for the run aggregate. Soft-fails per
 * field — one bad field on one customer doesn't kill the row.
 */
async function enrichOneCustomer(
  row: BaseSheetEnrichmentRow,
  result: EnrichmentResult,
): Promise<void> {
  for (const def of ENRICHMENT_FIELDS) {
    const fieldStats = result.per_field[def.label];
    let value: string | null;
    try {
      value = def.extract(row as unknown as Record<string, string>);
    } catch (e) {
      fieldStats.failed++;
      result.facts_failed++;
      result.errors.push(
        `${row.customer_id} ${def.label}: extract threw ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    if (!value) continue;

    // Fast-path idempotency: if Keeper already has this exact value,
    // skip the write entirely. Cuts ~95% of weekly writes on the steady
    // state.
    let probe: { exists: boolean; same_value: boolean };
    try {
      probe = await probeExistingFact({
        customer_id: row.customer_id,
        topic_subcategory: def.topic_subcategory,
        field_name: def.field_name,
        value,
      });
    } catch (e) {
      // Probe failure shouldn't block the write — fall through and let
      // writeBrainFact() resolve. Just log so we know the probe is
      // unhealthy.
      result.errors.push(
        `${row.customer_id} ${def.label}: probe failed ${e instanceof Error ? e.message : String(e)}`,
      );
      probe = { exists: false, same_value: false };
    }

    if (probe.same_value) {
      fieldStats.unchanged++;
      result.facts_unchanged++;
      continue;
    }

    try {
      const written = await writeBrainFact({
        customer_id: row.customer_id,
        topic_category: def.topic_category,
        topic_subcategory: def.topic_subcategory,
        field_name: def.field_name,
        value,
        source_type: "basesheet",
        source_ref: `metabase:basesheet:${row.entity_id}`,
        owning_am_email: null,
        // Auto-confirm under the system identity — high-trust SoR.
        confirmed_by_email: SYSTEM_EMAIL,
      });
      if (!written) {
        fieldStats.failed++;
        result.facts_failed++;
        result.errors.push(
          `${row.customer_id} ${def.label}: writeBrainFact returned null`,
        );
        continue;
      }
      if (probe.exists) {
        // Value differed → write landed as a refine (named field) or as
        // an additional "other" row. Count separately so the admin page
        // can show "real churn" vs "first-time landing".
        fieldStats.refined++;
        result.facts_refined++;
      } else {
        fieldStats.written++;
        result.facts_written++;
      }
    } catch (e) {
      if (e instanceof SemanticConflictError) {
        // Semantic dup — a sibling fact already says the same thing in
        // different words. Treat as unchanged so we don't double-count
        // and so the failed bucket stays honest.
        fieldStats.unchanged++;
        result.facts_unchanged++;
        continue;
      }
      fieldStats.failed++;
      result.facts_failed++;
      result.errors.push(
        `${row.customer_id} ${def.label}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/**
 * Top-level entrypoint called by the cron route. Pulls BaseSheet, joins
 * to the snapshot's active customer list, runs each row through the
 * enrichment fields, returns the aggregate stats.
 *
 * Bounded by the snapshot's active list (~900 customers × ~3 fields =
 * ~2,700 row probes per run, mostly fast-path no-ops). Vercel 1024MB /
 * 300s budget is comfortable.
 */
export async function runMetabaseEnrichment(opts?: {
  /** Optional cap — useful when running ad-hoc from `/admin`. */
  limit_customers?: number;
}): Promise<EnrichmentResult> {
  const startedAt = new Date();
  const result: EnrichmentResult = {
    started_at: startedAt.toISOString(),
    finished_at: "",
    customers_in_snapshot: 0,
    customers_in_basesheet: 0,
    customers_processed: 0,
    customers_skipped: 0,
    facts_written: 0,
    facts_refined: 0,
    facts_unchanged: 0,
    facts_failed: 0,
    errors: [],
    per_field: {},
  };
  for (const def of ENRICHMENT_FIELDS) {
    result.per_field[def.label] = {
      label: def.label,
      written: 0,
      refined: 0,
      unchanged: 0,
      failed: 0,
    };
  }

  let activeIds: Set<string>;
  try {
    activeIds = await listSnapshotCustomerIds();
  } catch (e) {
    result.errors.push(
      `snapshot read failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    result.finished_at = new Date().toISOString();
    return result;
  }
  result.customers_in_snapshot = activeIds.size;
  if (activeIds.size === 0) {
    result.errors.push("no active customers in snapshot — refusing to run");
    result.finished_at = new Date().toISOString();
    return result;
  }

  let rows: BaseSheetEnrichmentRow[];
  try {
    rows = await fetchBaseSheetEnrichmentRows();
  } catch (e) {
    result.errors.push(
      `basesheet fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    result.finished_at = new Date().toISOString();
    return result;
  }
  result.customers_in_basesheet = rows.length;

  // Filter to snapshot-active customers only. BaseSheet ships rows for
  // churned/inactive customers that the snapshot has correctly dropped;
  // enriching them would pollute Keeper with stale facts.
  const active = rows.filter((r) => activeIds.has(r.customer_id));
  const limited =
    opts?.limit_customers && opts.limit_customers > 0
      ? active.slice(0, opts.limit_customers)
      : active;

  for (const row of limited) {
    try {
      await enrichOneCustomer(row, result);
      result.customers_processed++;
    } catch (e) {
      // Catch-all guard — enrichOneCustomer is already soft-failing per
      // field, but if something escapes (e.g. an OOM mid-row), count it
      // as a skipped customer rather than killing the run.
      result.customers_skipped++;
      result.errors.push(
        `${row.customer_id}: row threw ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  result.finished_at = new Date().toISOString();
  return result;
}
