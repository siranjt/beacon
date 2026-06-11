/**
 * META-A4 — metabase-enrichment tests.
 *
 * Mocks: postgres (tagged-template stub matching extract-from-notes
 * pattern), global fetch (BaseSheet CSV), and readLatestSnapshotV2.
 * The writeBrainFact path is the real repo function — we don't mock it
 * — but the postgres stub captures its queries so we can assert what
 * writes fired.
 *
 * Coverage:
 *   1. Happy path: snapshot + BaseSheet rows produce N field writes
 *      across the right Keeper slots.
 *   2. Idempotency: re-running with the same probe value produces zero
 *      writes (counted as unchanged).
 *   3. Soft-fail per customer: one row that throws during processing
 *      doesn't kill the run; the cron continues to the next row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SnapshotV2 } from "../customer/types";

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

type TaggedStub = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown>;

interface MockState {
  recorded: RecordedQuery[];
  /** FIFO queue of canned result batches. */
  nextResults: Array<Array<Record<string, unknown>>>;
  /** Optional per-test override of the tagged stub. */
  overrideStub: TaggedStub | null;
  /** Snapshot returned by readLatestSnapshotV2. */
  snapshot: SnapshotV2 | null;
  /** CSV body returned by fetch. */
  fetchCsv: string | null;
  /** When set, fetch throws this. */
  fetchError: Error | null;
}

const state: MockState = {
  recorded: [],
  nextResults: [],
  overrideStub: null,
  snapshot: null,
  fetchCsv: null,
  fetchError: null,
};

function defaultTaggedStub(): TaggedStub {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = strings.join("?");
    state.recorded.push({ sql: flat, params: values });
    const next = state.nextResults.shift();
    return Promise.resolve(next ?? []);
  };
}

vi.mock("../customer/postgres", () => ({
  getSql: () => state.overrideStub ?? defaultTaggedStub(),
  readLatestSnapshotV2: () => Promise.resolve(state.snapshot),
}));

// Mock the embeddings module so writeBrainFact's semantic-conflict
// probe doesn't try to call Voyage during tests. Returning null from
// embedText() makes findSemanticNeighbor() return null, which skips
// the gate entirely — matching the no-VOYAGE_API_KEY branch.
vi.mock("./embeddings", () => ({
  embedText: () => Promise.resolve(null),
  factEmbeddingText: (sub: string, field: string, value: string) =>
    `${sub}/${field}: ${value}`,
  formatVectorLiteral: () => null,
  SEMANTIC_DUPLICATE_THRESHOLD: 0.97,
}));

// Mock the ranking module so writeBrainFact's post-write
// applyConflictResolution is a no-op in tests.
vi.mock("./ranking", () => ({
  applyConflictResolution: () => Promise.resolve(),
}));

// Global fetch mock — returns the canned CSV body.
const originalFetch = global.fetch;
beforeEach(() => {
  state.recorded = [];
  state.nextResults = [];
  state.overrideStub = null;
  state.snapshot = null;
  state.fetchCsv = null;
  state.fetchError = null;

  global.fetch = (async (_url: unknown, _opts: unknown) => {
    if (state.fetchError) throw state.fetchError;
    return {
      ok: true,
      status: 200,
      text: () => Promise.resolve(state.fetchCsv ?? ""),
    } as unknown as Response;
  }) as typeof fetch;
});

afterEachRestore();
function afterEachRestore() {
  // Vitest's afterEach is implicit-import-only; replicate via import.
}
import { afterAll } from "vitest";
afterAll(() => {
  global.fetch = originalFetch;
});

// Import AFTER mocks so the helper picks up the stubs.
import { runMetabaseEnrichment } from "./metabase-enrichment";

function fakeSnapshot(customer_ids: string[]): SnapshotV2 {
  return {
    customers: customer_ids.map((customer_id) => ({
      customer_id,
      entity_id: `eid-${customer_id}`,
      subscription_id: `sub-${customer_id}`,
      company: `Biz ${customer_id}`,
      email: "",
      phone: "",
      am_name: "Test AM",
      ae_name: "",
      sp_name: "",
      cb_status: "active",
      auto_collection: null,
      plan_amount: 0,
      mrr_basesheet: "",
      zoca_status: "",
      churn_potential_flag: "",
      activated_at: null,
      ob_date: "",
      match_source: "customer_id",
      in_chrone: false,
      metrics: {} as never,
      signals: {} as never,
      pod: "",
      usage: null,
      billing: null,
      performance: null,
      tickets: null,
      signals_v2: {} as never,
    })) as never,
  } as unknown as SnapshotV2;
}

const HAPPY_PATH_CSV =
  "customer_id,entity_id,bizname,primary_category,updated_primary_category,lead_source,chrone_zoca_status\n" +
  "cus_1,e-1,Glam by Gibbs,Hair salon,,Google,Zoca\n" +
  "cus_2,e-2,Velvet Cuts,Barber shop,Modern Barbershop,Referral,Chrone\n";

describe("runMetabaseEnrichment — happy path", () => {
  it("writes N facts when source has data for snapshot-active customers", async () => {
    state.snapshot = fakeSnapshot(["cus_1", "cus_2"]);
    state.fetchCsv = HAPPY_PATH_CSV;

    // Probe queue for cus_1 × 3 fields, then cus_2 × 3 fields. Each
    // probe + write per field consumes 2 results: probe row then INSERT
    // returning the new row. Since our defaults return empty arrays,
    // probes report "no existing row" and writes return a fake row.
    //
    // probeExistingFact for 'other' field returns rows.length > 0 from
    // probe query — we queue [] for each probe (no match) then queue
    // RETURNING fake for each insert. writeBrainFact for 'other' also
    // emits a writeVersion INSERT. We queue empty for those.
    //
    // For named field 'integration_state', writeBrainFact ALSO runs an
    // existing-row check itself — queue [] so it treats as fresh insert.
    //
    // To keep the test deterministic without modeling every query, we
    // queue a generic "[]" default for unmatched probes. The default
    // stub returns [] when the FIFO is empty.
    const fakeRow = { fact_id: "f1", customer_id: "cus_1", value: "x" };
    // Per row × per field, the helper runs:
    //   probe (1q) + writeBrainFact[neighbor probe (no embed -> 0 queries)
    //                              + (named only) existing-row check (1q)
    //                              + INSERT RETURNING (1q)
    //                              + writeVersion INSERT (1q)]
    //
    // For 'other' fields (business_type, lead_source): no extra existing-row
    // check (insert-only path). So per other-field call: probe + insert +
    // version = 3 queries (insert returns fakeRow).
    //
    // For 'integration_state' (named): probe + existing-row check + insert +
    // version = 4 queries.
    //
    // Total per customer: 3 + 3 + 4 = 10 queries. Two customers = 20.
    // We seed enough fake INSERT returns; defaults fill the empties.
    for (let i = 0; i < 50; i++) {
      state.nextResults.push([fakeRow]);
    }
    // Override the queue so probes get [] (no match) and inserts get
    // fakeRow. Easier: use a custom stub that branches on SQL shape.
    state.nextResults = [];
    state.overrideStub = (strings, ...values) => {
      const flat = strings.join("?");
      state.recorded.push({ sql: flat, params: values });
      if (/INSERT\s+INTO\s+beacon_brain_facts/i.test(flat)) {
        // Insert path — return a fake row so writeBrainFact treats it
        // as written.
        return Promise.resolve([
          {
            fact_id: "f1",
            customer_id: "cus_1",
            topic_category: "identity",
            topic_subcategory: "business_profile",
            field_name: "other",
            value: "x",
            confidence_state: "confirmed",
            source_type: "basesheet",
            source_ref: null,
            owning_am_email: null,
            confirmed_by_email: "system+enrichment@beacon.zoca",
            confirmed_at: null,
            sunset_at: null,
            current_version: 1,
            created_at: null,
            updated_at: null,
            soft_deleted_at: null,
            citation_count: 0,
            last_cited_at: null,
            value_numeric: null,
          },
        ]);
      }
      // All other queries (probes + version log INSERTs) → [].
      return Promise.resolve([]);
    };

    const r = await runMetabaseEnrichment();

    expect(r.customers_in_snapshot).toBe(2);
    expect(r.customers_in_basesheet).toBe(2);
    expect(r.customers_processed).toBe(2);
    expect(r.customers_skipped).toBe(0);
    // 3 fields × 2 customers, all probes report "no existing" → all
    // count as written.
    expect(r.facts_written).toBe(6);
    expect(r.facts_unchanged).toBe(0);
    expect(r.facts_failed).toBe(0);
    expect(r.per_field.business_type.written).toBe(2);
    expect(r.per_field.lead_source.written).toBe(2);
    expect(r.per_field.integration_state.written).toBe(2);
  });
});

describe("runMetabaseEnrichment — idempotency", () => {
  it("counts repeat values as unchanged (no INSERT fires)", async () => {
    state.snapshot = fakeSnapshot(["cus_1"]);
    state.fetchCsv =
      "customer_id,entity_id,bizname,primary_category,updated_primary_category,lead_source,chrone_zoca_status\n" +
      "cus_1,e-1,Glam by Gibbs,Hair salon,,Google,Zoca\n";

    // Every probe returns a row with the EXACT value we're about to
    // write. probeExistingFact reports same_value=true → skip.
    state.overrideStub = (strings, ...values) => {
      const flat = strings.join("?");
      state.recorded.push({ sql: flat, params: values });
      if (/INSERT\s+INTO\s+beacon_brain_facts/i.test(flat)) {
        // Reject — no insert should fire on an idempotent run.
        throw new Error("INSERT fired on supposedly idempotent run");
      }
      // probe queries:
      //   field_name = 'other' branch SELECTs fact_id WHERE ... AND value = $
      //   field_name = named branch SELECTs value WHERE ...
      // Both want to look like a match with the same value.
      if (/SELECT\s+fact_id\s+FROM\s+beacon_brain_facts/i.test(flat)) {
        // 'other' probe — return any row to signal "exists".
        return Promise.resolve([{ fact_id: "existing-other" }]);
      }
      if (/SELECT\s+value\s+FROM\s+beacon_brain_facts/i.test(flat)) {
        // Named-field probe — return the EXACT value the extractor
        // would produce for chrone_zoca_status (the only named field
        // we map). The value is verbatim "Zoca".
        return Promise.resolve([{ value: "Zoca" }]);
      }
      return Promise.resolve([]);
    };

    const r = await runMetabaseEnrichment();

    expect(r.facts_written).toBe(0);
    expect(r.facts_refined).toBe(0);
    expect(r.facts_unchanged).toBe(3);
    expect(r.facts_failed).toBe(0);
    expect(r.per_field.business_type.unchanged).toBe(1);
    expect(r.per_field.lead_source.unchanged).toBe(1);
    expect(r.per_field.integration_state.unchanged).toBe(1);
  });
});

describe("runMetabaseEnrichment — soft-fail per customer", () => {
  it("continues to the next customer when one row throws", async () => {
    state.snapshot = fakeSnapshot(["cus_1", "cus_2"]);
    state.fetchCsv = HAPPY_PATH_CSV;

    // cus_1's first probe throws; cus_2 succeeds. The helper should
    // accumulate the error and continue.
    let cus1FirstProbeBlown = false;
    state.overrideStub = (strings, ...values) => {
      const flat = strings.join("?");
      state.recorded.push({ sql: flat, params: values });
      // Detect a probe targeting cus_1 by inspecting the bound params
      // — customer_id is always the first $1 in our probes.
      const isCus1 = values.includes("cus_1");
      if (
        isCus1 &&
        !cus1FirstProbeBlown &&
        /SELECT\s+fact_id\s+FROM\s+beacon_brain_facts/i.test(flat)
      ) {
        cus1FirstProbeBlown = true;
        return Promise.reject(new Error("probe boom for cus_1"));
      }
      if (/INSERT\s+INTO\s+beacon_brain_facts/i.test(flat)) {
        return Promise.resolve([
          {
            fact_id: "f2",
            customer_id: "cus_2",
            topic_category: "identity",
            topic_subcategory: "business_profile",
            field_name: "other",
            value: "y",
            confidence_state: "confirmed",
            source_type: "basesheet",
            source_ref: null,
            owning_am_email: null,
            confirmed_by_email: "system+enrichment@beacon.zoca",
            confirmed_at: null,
            sunset_at: null,
            current_version: 1,
            created_at: null,
            updated_at: null,
            soft_deleted_at: null,
            citation_count: 0,
            last_cited_at: null,
            value_numeric: null,
          },
        ]);
      }
      return Promise.resolve([]);
    };

    const r = await runMetabaseEnrichment();

    // Both customers reach processing (the probe error is captured as
    // a soft-fail; the field continues with probe = no-match, and
    // writeBrainFact lands the row).
    expect(r.customers_processed).toBe(2);
    expect(r.customers_skipped).toBe(0);
    // The thrown probe surfaces on `errors`.
    expect(r.errors.some((e) => e.includes("probe failed") || e.includes("probe boom"))).toBe(true);
    // cus_2 should land all 3 fields cleanly.
    expect(r.facts_written).toBeGreaterThanOrEqual(3);
  });

  it("returns immediately with an error when the snapshot is missing", async () => {
    state.snapshot = null;
    const r = await runMetabaseEnrichment();
    expect(r.customers_in_snapshot).toBe(0);
    expect(r.facts_written).toBe(0);
    expect(r.errors.some((e) => e.includes("no active customers"))).toBe(true);
  });

  it("returns immediately with an error when the BaseSheet fetch fails", async () => {
    state.snapshot = fakeSnapshot(["cus_1"]);
    state.fetchError = new Error("network down");
    const r = await runMetabaseEnrichment();
    expect(r.customers_in_basesheet).toBe(0);
    expect(r.errors.some((e) => e.includes("basesheet fetch failed"))).toBe(true);
  });
});
