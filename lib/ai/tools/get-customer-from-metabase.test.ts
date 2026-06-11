/**
 * Tests for get_customer_from_metabase — the BaseSheet fallback tool.
 *
 * Coverage:
 *   1. Happy path — BaseSheet row found, structured fields returned,
 *      Keeper write-back fires for each mapped column.
 *   2. Taxonomy mapping is correct — each BaseSheet column lands on its
 *      documented (category, subcategory, field_name) triple with the
 *      shaped value.
 *   3. Soft-fail per fact — when writeBrainFact throws (semantic conflict,
 *      etc.) on one column, other writes still land and the tool returns ok.
 *   4. Entity not in BaseSheet — tool returns ok with found=false (no throw).
 *   5. Empty input — entity_id missing returns ok=false.
 *   6. Missing customer_id — when BaseSheet row has no Chargebee handle,
 *      tool still returns fields but skips write-back (no key to write under).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolExecutionContext } from "./index";

const readLatestSnapshotV2 = vi.fn();
const fetchBaseSheet = vi.fn();
const writeBrainFact = vi.fn();
const logUmbrellaActivity = vi.fn();

vi.mock("@/lib/customer/postgres", () => ({
  readLatestSnapshotV2: () => readLatestSnapshotV2(),
}));
vi.mock("@/lib/customer/metabase", () => ({
  fetchBaseSheet: () => fetchBaseSheet(),
}));
vi.mock("@/lib/brain/repo", () => ({
  writeBrainFact: (...args: unknown[]) => writeBrainFact(...args),
}));
vi.mock("@/lib/activity/log", () => ({
  logUmbrellaActivity: (...args: unknown[]) => logUmbrellaActivity(...args),
}));

// server-only is a no-op in test env.
vi.mock("server-only", () => ({}));

import { getCustomerFromMetabaseTool } from "./get-customer-from-metabase";

const ENTITY_ID = "e1b2c3d4-aaaa-bbbb-cccc-dddddddddddd";
const CB_ID = "cb_abc123";
const BIZNAME = "Pearl Salon";

function makeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    amEmail: "am@zoca.com",
    amName: "Kanak sharma",
    role: "am",
    customerId: ENTITY_ID,
    customerName: BIZNAME,
    cbCustomerId: CB_ID,
    ...overrides,
  };
}

function defaultRow() {
  return {
    entity_id: ENTITY_ID,
    customer_id: CB_ID,
    bizname: BIZNAME,
    am_name: "Kanak sharma",
    ae_name: "Jenny AE",
    sp_name: "",
    app_email: "owner@pearl.com",
    phone_number: "+15555550100",
    total_monthly_revenue: "$249",
    chrone_zoca_status: "active",
    churn_potential_flag: "",
    churn_potential_status: "",
    ob_date: "2025-09-15",
    open_tickets_30d: "0",
    unresolved_issues_last_30_days: "0",
  };
}

function defaultSnapshot() {
  return {
    customers: [
      {
        entity_id: ENTITY_ID,
        company: BIZNAME,
        customer_id: CB_ID,
        am_name: "Kanak sharma",
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  readLatestSnapshotV2.mockResolvedValue(defaultSnapshot());
  fetchBaseSheet.mockResolvedValue({
    rows: [defaultRow()],
    byCustomerId: { [CB_ID]: defaultRow() },
    byCustomerIdMulti: { [CB_ID]: [defaultRow()] },
    byEntityId: { [ENTITY_ID]: defaultRow() },
    byBizName: {},
  });
  writeBrainFact.mockResolvedValue({ fact_id: "fake" });
  logUmbrellaActivity.mockResolvedValue(undefined);
});

describe("get_customer_from_metabase — happy path", () => {
  it("returns structured BaseSheet fields and writes facts back to Keeper", async () => {
    const result = await getCustomerFromMetabaseTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;

    expect(data.found).toBe(true);
    expect(data.customer_id).toBe(CB_ID);
    expect(data.bizname).toBe(BIZNAME);

    const fields = data.fields as Record<string, string>;
    expect(fields.bizname).toBe(BIZNAME);
    expect(fields.ae_name).toBe("Jenny AE");
    expect(fields.app_email).toBe("owner@pearl.com");
    expect(fields.total_monthly_revenue).toBe("$249");
    expect(fields.chrone_zoca_status).toBe("active");
    expect(fields.ob_date).toBe("2025-09-15");
    // sp_name is empty — should be stripped
    expect(fields.sp_name).toBeUndefined();

    const wb = data.writeback as Record<string, unknown>;
    // 5 mapped columns are all non-empty in defaultRow → 5 writes attempted.
    expect(wb.facts_written).toBe(5);
    expect(wb.facts_failed).toBe(0);

    // Verify the activity log fired with the right metadata.
    expect(logUmbrellaActivity).toHaveBeenCalledTimes(1);
    const logCall = logUmbrellaActivity.mock.calls[0][0] as Record<string, unknown>;
    const meta = logCall.metadata as Record<string, unknown>;
    expect(meta.tool).toBe("get_customer_from_metabase");
    expect(meta.fields_returned).toBeGreaterThan(0);
    expect(meta.facts_written_back).toBe(5);
    expect(typeof meta.metabase_query_ms).toBe("number");
  });
});

describe("get_customer_from_metabase — taxonomy mapping", () => {
  it("maps each BaseSheet column to its documented Keeper triple with shaped value", async () => {
    await getCustomerFromMetabaseTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    const calls = writeBrainFact.mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    const byField = new Map(
      calls.map((c) => [`${c.topic_subcategory}/${c.field_name}/${c.value}`, c]),
    );

    // ae_name → identity/sold_by/sold_by_ae, value verbatim
    const ae = calls.find(
      (c) => c.topic_subcategory === "sold_by" && c.field_name === "sold_by_ae",
    );
    expect(ae).toBeDefined();
    expect(ae!.topic_category).toBe("identity");
    expect(ae!.value).toBe("Jenny AE");
    expect(ae!.source_type).toBe("basesheet");
    expect(ae!.confirmed_by_email).toBe("system-metabase-fallback@beacon.zoca");

    // ob_date → identity/sold_by/sold_at
    const ob = calls.find(
      (c) => c.topic_subcategory === "sold_by" && c.field_name === "sold_at",
    );
    expect(ob).toBeDefined();
    expect(ob!.value).toBe("2025-09-15");

    // app_email → identity/owner_info/other, labeled-prefix value
    const email = calls.find(
      (c) =>
        c.topic_subcategory === "owner_info" &&
        c.field_name === "other" &&
        String(c.value).startsWith("app_email:"),
    );
    expect(email).toBeDefined();
    expect(email!.topic_category).toBe("identity");
    expect(email!.value).toBe("app_email: owner@pearl.com");

    // total_monthly_revenue → operational/contract/mrr_amount, BaseSheet-tagged
    const mrr = calls.find(
      (c) =>
        c.topic_subcategory === "contract" && c.field_name === "mrr_amount",
    );
    expect(mrr).toBeDefined();
    expect(mrr!.topic_category).toBe("operational");
    expect(mrr!.value).toBe("$249 (BaseSheet)");

    // chrone_zoca_status → operational/contract/other, labeled-prefix value
    const status = calls.find(
      (c) =>
        c.topic_subcategory === "contract" &&
        c.field_name === "other" &&
        String(c.value).startsWith("zoca_status:"),
    );
    expect(status).toBeDefined();
    expect(status!.value).toBe("zoca_status: active");

    // Spot-check source_ref carries a basesheet timestamp marker.
    for (const c of calls) {
      expect(String(c.source_ref)).toMatch(/^metabase:basesheet:/);
    }

    // Catch unused but-checked variable so the linter doesn't complain.
    expect(byField.size).toBeGreaterThan(0);
  });

  it("skips ob_date with literal 'N/A' value", async () => {
    const row = { ...defaultRow(), ob_date: "N/A" };
    fetchBaseSheet.mockResolvedValueOnce({
      rows: [row],
      byCustomerId: { [CB_ID]: row },
      byCustomerIdMulti: { [CB_ID]: [row] },
      byEntityId: { [ENTITY_ID]: row },
      byBizName: {},
    });

    await getCustomerFromMetabaseTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    const calls = writeBrainFact.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const ob = calls.find(
      (c) => c.topic_subcategory === "sold_by" && c.field_name === "sold_at",
    );
    expect(ob).toBeUndefined();
  });
});

describe("get_customer_from_metabase — soft-fail per fact", () => {
  it("one rejected write does not block the rest", async () => {
    // Make ae_name's write throw. Others land.
    writeBrainFact.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.field_name === "sold_by_ae") {
        throw new Error("semantic conflict: too close to existing fact");
      }
      return { fact_id: "fake" };
    });

    const result = await getCustomerFromMetabaseTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    const wb = data.writeback as Record<string, unknown>;
    // 4 succeed, 1 fails. Tool still returns the fields.
    expect(wb.facts_written).toBe(4);
    expect(wb.facts_failed).toBe(1);

    const details = wb.details as Array<Record<string, unknown>>;
    const failed = details.find((d) => d.field_name === "sold_by_ae");
    expect(failed).toBeDefined();
    expect(failed!.written).toBe(false);
    expect(String(failed!.error)).toContain("semantic conflict");

    // Other fields still land.
    const fields = data.fields as Record<string, string>;
    expect(fields.ae_name).toBe("Jenny AE");
  });
});

describe("get_customer_from_metabase — entity not in BaseSheet", () => {
  it("returns ok with found=false and skips write-back", async () => {
    fetchBaseSheet.mockResolvedValueOnce({
      rows: [],
      byCustomerId: {},
      byCustomerIdMulti: {},
      byEntityId: {},
      byBizName: {},
    });

    const result = await getCustomerFromMetabaseTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.found).toBe(false);
    expect(writeBrainFact).not.toHaveBeenCalled();
  });
});

describe("get_customer_from_metabase — input validation", () => {
  it("returns ok=false on missing entity_id", async () => {
    const result = await getCustomerFromMetabaseTool.execute({}, makeCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("entity_id");
  });

  it("returns ok=false on empty entity_id", async () => {
    const result = await getCustomerFromMetabaseTool.execute(
      { entity_id: "   " },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
  });
});

describe("get_customer_from_metabase — missing Chargebee customer_id", () => {
  it("returns fields but skips write-back (no key)", async () => {
    const row = { ...defaultRow(), customer_id: "" };
    fetchBaseSheet.mockResolvedValueOnce({
      rows: [row],
      byCustomerId: {},
      byCustomerIdMulti: {},
      byEntityId: { [ENTITY_ID]: row },
      byBizName: {},
    });
    // Snapshot has no customer_id either.
    readLatestSnapshotV2.mockResolvedValueOnce({
      customers: [
        { entity_id: ENTITY_ID, company: BIZNAME, customer_id: "" },
      ],
    });

    const result = await getCustomerFromMetabaseTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.found).toBe(true);
    // No writes attempted.
    expect(writeBrainFact).not.toHaveBeenCalled();
    const wb = data.writeback as Record<string, unknown>;
    expect(wb.facts_written).toBe(0);
    // But fields still returned.
    expect(data.fields).toBeDefined();
  });
});

describe("get_customer_from_metabase — registered in scope allowlist", () => {
  it("is exposed by the customer-360 allowlist", async () => {
    const { SCOPE_TOOL_ALLOWLIST } = await import("./index");
    const names = SCOPE_TOOL_ALLOWLIST["customer-360"]!.map((t) => t.name);
    expect(names).toContain("get_customer_from_metabase");
  });

  it("is exposed by the customer-book allowlist", async () => {
    const { SCOPE_TOOL_ALLOWLIST } = await import("./index");
    const names = SCOPE_TOOL_ALLOWLIST["customer-book"]!.map((t) => t.name);
    expect(names).toContain("get_customer_from_metabase");
  });

  it("is exposed by the performance-report allowlist", async () => {
    const { SCOPE_TOOL_ALLOWLIST } = await import("./index");
    const names = SCOPE_TOOL_ALLOWLIST["performance-report"]!.map((t) => t.name);
    expect(names).toContain("get_customer_from_metabase");
  });

  it("is exposed by the escalation-overview allowlist", async () => {
    const { SCOPE_TOOL_ALLOWLIST } = await import("./index");
    const names = SCOPE_TOOL_ALLOWLIST["escalation-overview"]!.map((t) => t.name);
    expect(names).toContain("get_customer_from_metabase");
  });

  it("is exposed by the miss-payment-overview allowlist", async () => {
    const { SCOPE_TOOL_ALLOWLIST } = await import("./index");
    const names = SCOPE_TOOL_ALLOWLIST["miss-payment-overview"]!.map((t) => t.name);
    expect(names).toContain("get_customer_from_metabase");
  });

  it("is NOT exposed by lightweight scopes (inbox, performance-landing)", async () => {
    const { SCOPE_TOOL_ALLOWLIST } = await import("./index");
    const inbox = SCOPE_TOOL_ALLOWLIST["inbox"]!.map((t) => t.name);
    const landing = SCOPE_TOOL_ALLOWLIST["performance-landing"]!.map((t) => t.name);
    expect(inbox).not.toContain("get_customer_from_metabase");
    expect(landing).not.toContain("get_customer_from_metabase");
  });
});
