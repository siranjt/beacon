/**
 * META-A2 — bootstrap-from-basesheet unit tests.
 *
 * The bootstrap helper hits three external surfaces:
 *   1. fetchBaseSheet (Metabase CSV)  → mocked
 *   2. readLatestSnapshotV2 (Postgres) → mocked
 *   3. writeBrainFact + getSql (Postgres) → mocked
 *
 * Each test wires the mocks freshly via vi.resetModules so we can verify:
 *   - mapBaseSheetRowToFacts produces the expected shape
 *   - bootstrapKeeperForEntities is idempotent (second run is a no-op
 *     via existing-facts pre-filter + SemanticConflictError accounting)
 *   - Per-entity / per-fact soft-fail (one bad row doesn't poison the batch)
 *   - Counters match what was actually written
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BaseSheetRow } from "../customer/types";

/**
 * Per-test mutable mock state. We re-seed at the top of each `it()` so
 * tests don't leak into each other.
 */
type WriteCall = {
  customer_id: string;
  topic_subcategory: string;
  field_name: string;
  value: string;
  source_type: string;
};

const state: {
  baseSheetRows: BaseSheetRow[];
  snapshotCustomers: Array<{ entity_id: string; customer_id: string }>;
  /** (customer_id|subcategory|field) keys already present in the fact store. */
  existingFactKeys: Set<string>;
  writeCalls: WriteCall[];
  writeBehavior: "ok" | "throw_semantic_conflict" | "throw_generic";
  sqlConfigured: boolean;
} = {
  baseSheetRows: [],
  snapshotCustomers: [],
  existingFactKeys: new Set(),
  writeCalls: [],
  writeBehavior: "ok",
  sqlConfigured: true,
};

vi.mock("../customer/metabase", () => ({
  fetchBaseSheet: vi.fn(async () => {
    const byEntityId: Record<string, BaseSheetRow> = {};
    for (const r of state.baseSheetRows) {
      if (r.entity_id) byEntityId[r.entity_id] = r;
    }
    return {
      rows: state.baseSheetRows,
      byCustomerId: {},
      byCustomerIdMulti: {},
      byEntityId,
      byBizName: {},
    };
  }),
}));

vi.mock("../customer/postgres", () => ({
  readLatestSnapshotV2: vi.fn(async () => ({
    customers: state.snapshotCustomers,
  })),
  getSql: () => {
    if (!state.sqlConfigured) return null;
    // Tagged-template stub — only used by findExistingNamedFacts to read
    // the existing-keys set. Returns rows shaped like the helper expects.
    return (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<unknown> => {
      // Find the customer_id parameter (first ${...} interpolation).
      const customer_id = String(values[0] ?? "");
      const rows: Array<{ topic_subcategory: string; field_name: string }> = [];
      for (const key of state.existingFactKeys) {
        const [cid, sub, field] = key.split("|");
        if (cid === customer_id) {
          rows.push({ topic_subcategory: sub, field_name: field });
        }
      }
      void strings;
      return Promise.resolve(rows);
    };
  },
}));

vi.mock("./repo", () => ({
  writeBrainFact: vi.fn(
    async (input: {
      customer_id: string;
      topic_subcategory: string;
      field_name: string;
      value: string;
      source_type: string;
    }) => {
      if (state.writeBehavior === "throw_semantic_conflict") {
        throw new Error(
          `semantic conflict: proposed "${input.value}" overlaps existing fact xyz`,
        );
      }
      if (state.writeBehavior === "throw_generic") {
        throw new Error("db connection lost");
      }
      state.writeCalls.push({
        customer_id: input.customer_id,
        topic_subcategory: input.topic_subcategory,
        field_name: input.field_name,
        value: input.value,
        source_type: input.source_type,
      });
      // Record so that re-runs see the slot as occupied.
      state.existingFactKeys.add(
        `${input.customer_id}|${input.topic_subcategory}|${input.field_name}`,
      );
      return { fact_id: `fake-${state.writeCalls.length}` } as unknown;
    },
  ),
}));

function row(opts: Partial<BaseSheetRow> & Pick<BaseSheetRow, "entity_id">): BaseSheetRow {
  return {
    entity_id: opts.entity_id,
    customer_id: opts.customer_id ?? "",
    bizname: opts.bizname ?? "Test Biz",
    am_name: opts.am_name ?? "",
    ae_name: opts.ae_name ?? "",
    sp_name: opts.sp_name ?? "",
    app_email: opts.app_email ?? "",
    phone_number: opts.phone_number ?? "",
    total_monthly_revenue: opts.total_monthly_revenue ?? "",
    chrone_zoca_status: opts.chrone_zoca_status ?? "",
    churn_potential_flag: opts.churn_potential_flag ?? "",
    churn_potential_status: opts.churn_potential_status ?? "",
    ob_date: opts.ob_date ?? "",
    open_tickets_30d: opts.open_tickets_30d ?? "0",
    unresolved_issues_last_30_days: opts.unresolved_issues_last_30_days ?? "0",
  };
}

beforeEach(() => {
  state.baseSheetRows = [];
  state.snapshotCustomers = [];
  state.existingFactKeys = new Set();
  state.writeCalls = [];
  state.writeBehavior = "ok";
  state.sqlConfigured = true;
});

describe("mapBaseSheetRowToFacts", () => {
  it("emits one write per populated field, skips empty/N/A", async () => {
    const { mapBaseSheetRowToFacts } = await import("./metabase-bootstrap");
    const r = row({
      entity_id: "e1",
      customer_id: "cb_1",
      ae_name: "Jane AE",
      ob_date: "2025-01-15",
      total_monthly_revenue: "$450",
    });
    const writes = mapBaseSheetRowToFacts(r, "cb_1");
    expect(writes.map((w) => w.field_name).sort()).toEqual(
      ["mrr_amount", "sold_at", "sold_by_ae"].sort(),
    );
    // All facts confirmed at write (high-trust source)
    for (const w of writes) {
      expect(w.source_type).toBe("basesheet");
      expect(w.confirmed_by_email).toMatch(/^system\+bootstrap-basesheet/);
    }
  });

  it('skips ob_date when value is "N/A" (case-insensitive)', async () => {
    const { mapBaseSheetRowToFacts } = await import("./metabase-bootstrap");
    const r = row({
      entity_id: "e1",
      customer_id: "cb_1",
      ae_name: "Jane",
      ob_date: "n/a",
      total_monthly_revenue: "$100",
    });
    const writes = mapBaseSheetRowToFacts(r, "cb_1");
    expect(writes.find((w) => w.field_name === "sold_at")).toBeUndefined();
  });

  it("returns empty list when customer_id missing", async () => {
    const { mapBaseSheetRowToFacts } = await import("./metabase-bootstrap");
    const r = row({ entity_id: "e1", ae_name: "Jane" });
    expect(mapBaseSheetRowToFacts(r, "")).toEqual([]);
  });
});

describe("bootstrapKeeperForEntities", () => {
  it("writes 3 facts per entity, returns counts", async () => {
    state.baseSheetRows = [
      row({
        entity_id: "e1",
        customer_id: "cb_1",
        ae_name: "Jane",
        ob_date: "2025-01-15",
        total_monthly_revenue: "$450",
      }),
    ];
    const { bootstrapKeeperForEntities } = await import("./metabase-bootstrap");
    const result = await bootstrapKeeperForEntities(["e1"]);
    expect(result.entities_processed).toBe(1);
    expect(result.entities_skipped).toBe(0);
    expect(result.facts_written).toBe(3);
    expect(result.facts_failed).toBe(0);
    expect(state.writeCalls.length).toBe(3);
  });

  it("is idempotent — second run writes nothing", async () => {
    state.baseSheetRows = [
      row({
        entity_id: "e1",
        customer_id: "cb_1",
        ae_name: "Jane",
        ob_date: "2025-01-15",
        total_monthly_revenue: "$450",
      }),
    ];
    const { bootstrapKeeperForEntities } = await import("./metabase-bootstrap");
    const first = await bootstrapKeeperForEntities(["e1"]);
    expect(first.facts_written).toBe(3);

    // Re-run: existingFactKeys now populated from first run's writes.
    const second = await bootstrapKeeperForEntities(["e1"]);
    expect(second.facts_written).toBe(0);
    expect(second.facts_skipped_idempotent).toBe(3);
    expect(second.entities_processed).toBe(1);
    // No new writeBrainFact calls — total writeCalls still 3.
    expect(state.writeCalls.length).toBe(3);
  });

  it("treats SemanticConflictError as idempotent skip (not failure)", async () => {
    state.baseSheetRows = [
      row({
        entity_id: "e1",
        customer_id: "cb_1",
        ae_name: "Jane",
        ob_date: "2025-01-15",
        total_monthly_revenue: "$450",
      }),
    ];
    state.writeBehavior = "throw_semantic_conflict";
    const { bootstrapKeeperForEntities } = await import("./metabase-bootstrap");
    const result = await bootstrapKeeperForEntities(["e1"]);
    expect(result.facts_written).toBe(0);
    expect(result.facts_failed).toBe(0);
    expect(result.facts_skipped_idempotent).toBe(3);
    // No error rows for semantic-conflicts — they're expected
    expect(result.errors.length).toBe(0);
  });

  it("counts non-semantic write errors as failed, doesn't poison batch", async () => {
    state.baseSheetRows = [
      row({
        entity_id: "e1",
        customer_id: "cb_1",
        ae_name: "Jane",
        total_monthly_revenue: "$100",
      }),
      row({
        entity_id: "e2",
        customer_id: "cb_2",
        ae_name: "Bob",
        total_monthly_revenue: "$200",
      }),
    ];
    state.writeBehavior = "throw_generic";
    const { bootstrapKeeperForEntities } = await import("./metabase-bootstrap");
    const result = await bootstrapKeeperForEntities(["e1", "e2"]);
    // Both entities attempted, both failed, no throw bubbled
    expect(result.entities_processed).toBe(2);
    expect(result.facts_written).toBe(0);
    expect(result.facts_failed).toBeGreaterThan(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("skips entities with no BaseSheet row, records per-entity error", async () => {
    state.baseSheetRows = [
      row({
        entity_id: "e_known",
        customer_id: "cb_known",
        ae_name: "Jane",
      }),
    ];
    const { bootstrapKeeperForEntities } = await import("./metabase-bootstrap");
    const result = await bootstrapKeeperForEntities(["e_known", "e_missing"]);
    expect(result.entities_processed).toBe(1);
    expect(result.entities_skipped).toBe(1);
    expect(result.errors.some((e) => e.includes("e_missing"))).toBe(true);
  });

  it("falls back to snapshot for customer_id when BaseSheet row has empty cid", async () => {
    state.baseSheetRows = [
      row({
        entity_id: "e1",
        customer_id: "", // empty
        ae_name: "Jane",
      }),
    ];
    state.snapshotCustomers = [{ entity_id: "e1", customer_id: "cb_from_snap" }];
    const { bootstrapKeeperForEntities } = await import("./metabase-bootstrap");
    const result = await bootstrapKeeperForEntities(["e1"]);
    expect(result.entities_processed).toBe(1);
    expect(state.writeCalls[0]?.customer_id).toBe("cb_from_snap");
  });

  it("deduplicates input entity_ids", async () => {
    state.baseSheetRows = [
      row({
        entity_id: "e1",
        customer_id: "cb_1",
        ae_name: "Jane",
      }),
    ];
    const { bootstrapKeeperForEntities } = await import("./metabase-bootstrap");
    const result = await bootstrapKeeperForEntities(["e1", "e1", "e1"]);
    expect(result.entities_processed).toBe(1);
  });

  it("returns zero result for empty input", async () => {
    const { bootstrapKeeperForEntities } = await import("./metabase-bootstrap");
    const result = await bootstrapKeeperForEntities([]);
    expect(result).toEqual({
      entities_processed: 0,
      entities_skipped: 0,
      facts_written: 0,
      facts_skipped_idempotent: 0,
      facts_failed: 0,
      errors: [],
    });
  });
});
