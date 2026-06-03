/**
 * Tests for the query_customer_book executor (Phase F-polish-AI Tier 2).
 *
 * Tests target the pure `runQuery` function — no Postgres, no
 * Anthropic, no I/O. Covers:
 *   - Each metric × group_by combination at least once
 *   - Threshold bucketing semantics (cumulative — 95-day customer counts
 *     toward 30+, 60+, AND 90+)
 *   - Range bucketing semantics (disjoint — value falls into first match)
 *   - Sum mode returns sum + avg per group
 *   - Filter clauses (AM allowlist, stoplight subset, multi-key combination)
 *   - Sort modes (group_key alphabetical, total desc, first_bucket_desc)
 *   - Edge cases: empty input, null fields, unassigned AM bucket
 *   - Limit enforcement and clamping (1..200)
 *   - Recently-churned exclusion lives at the executor.execute() layer
 *     since runQuery is pure — that's covered separately in integration.
 */

import { describe, it, expect } from "vitest";
import { runQuery, buildQueryCitations } from "./query-customer-book";
import type { ScoredCustomerV2 } from "@/lib/customer/types";

// ─────────────────── Test fixtures ───────────────────────
//
// Minimal ScoredCustomerV2 builder. Only fields we read are populated.
// `as unknown as ScoredCustomerV2` because the full type is enormous and
// the executor only touches a tiny subset.

function makeCustomer(overrides: {
  entity_id?: string;
  am_name?: string | null;
  pod?: string;
  lifecycle_state?: ScoredCustomerV2["lifecycle_state"];
  stoplight?: "RED" | "YELLOW" | "GREEN" | null;
  tier?: string;
  composite?: number;
  days_since_out?: number | null;
  days_since_in?: number | null;
  plan_amount?: number;
  app_open_days?: number;
  open_tickets?: number;
  unpaid_invoice_count?: number;
  past_due_cents?: number;
}): ScoredCustomerV2 {
  const base = {
    entity_id: overrides.entity_id ?? "e_" + Math.random().toString(36).slice(2, 10),
    am_name: overrides.am_name === undefined ? "Kanak sharma" : (overrides.am_name ?? ""),
    pod: overrides.pod ?? "Pod 1",
    lifecycle_state: overrides.lifecycle_state ?? "active",
    plan_amount: overrides.plan_amount ?? 149,
    metrics: {
      days_since_out: overrides.days_since_out === undefined ? 10 : overrides.days_since_out,
      days_since_in: overrides.days_since_in === undefined ? 5 : overrides.days_since_in,
    },
    signals_v2: {
      stoplight: overrides.stoplight ?? "GREEN",
      tier: overrides.tier ?? "Healthy",
      composite: overrides.composite ?? 30,
    },
    usage: {
      distinct_app_open_days_30d: overrides.app_open_days ?? 15,
    },
    tickets: {
      open_count: overrides.open_tickets ?? 0,
    },
    billing: {
      unpaid_invoice_count: overrides.unpaid_invoice_count ?? 0,
      total_amount_due_cents: overrides.past_due_cents ?? 0,
    },
  };
  return base as unknown as ScoredCustomerV2;
}

// A representative book: 6 customers across 2 AMs, varied silence /
// composite / billing. Used by most tests to keep them readable.
function sampleBook(): ScoredCustomerV2[] {
  return [
    makeCustomer({ am_name: "Kanak sharma", days_since_out: 5, composite: 20, stoplight: "GREEN", tier: "Healthy", plan_amount: 149 }),
    makeCustomer({ am_name: "Kanak sharma", days_since_out: 35, composite: 55, stoplight: "YELLOW", tier: "Watch", plan_amount: 199 }),
    makeCustomer({ am_name: "Kanak sharma", days_since_out: 95, composite: 78, stoplight: "RED", tier: "At Risk", plan_amount: 249, open_tickets: 2, unpaid_invoice_count: 1, past_due_cents: 24900 }),
    makeCustomer({ am_name: "Hubern C", days_since_out: 65, composite: 70, stoplight: "RED", tier: "At Risk", plan_amount: 149, open_tickets: 1 }),
    makeCustomer({ am_name: "Hubern C", days_since_out: 130, composite: 88, stoplight: "RED", tier: "Critical", plan_amount: 99, open_tickets: 5, unpaid_invoice_count: 3, past_due_cents: 89700 }),
    makeCustomer({ am_name: null, days_since_out: 20, composite: 40, stoplight: "YELLOW", tier: "Watch", plan_amount: 149 }),
  ];
}

// ─────────────────── group_by + metric combinations ─────────────────────

describe("runQuery — outbound_silence × group_by=am with threshold buckets", () => {
  it("buckets are cumulative — 95-day customer counts in 30+, 60+, AND 90+", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30, 60, 90, 120] },
    });

    const kanak = result.rows.find((r) => r.group_key === "Kanak sharma");
    expect(kanak).toBeDefined();
    // Kanak customers: silence days 5, 35, 95
    expect(kanak!.total_customers).toBe(3);
    expect(kanak!.bucket_counts!["30d+"]).toBe(2);  // 35, 95
    expect(kanak!.bucket_counts!["60d+"]).toBe(1);  // 95
    expect(kanak!.bucket_counts!["90d+"]).toBe(1);  // 95
    expect(kanak!.bucket_counts!["120d+"]).toBe(0); // none

    const hubern = result.rows.find((r) => r.group_key === "Hubern C");
    expect(hubern).toBeDefined();
    // Hubern customers: silence days 65, 130
    expect(hubern!.total_customers).toBe(2);
    expect(hubern!.bucket_counts!["30d+"]).toBe(2);
    expect(hubern!.bucket_counts!["60d+"]).toBe(2);
    expect(hubern!.bucket_counts!["90d+"]).toBe(1);
    expect(hubern!.bucket_counts!["120d+"]).toBe(1);
  });

  it("unassigned customers bucket as '(Unassigned)'", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30] },
    });
    const unassigned = result.rows.find((r) => r.group_key === "(Unassigned)");
    expect(unassigned).toBeDefined();
    expect(unassigned!.total_customers).toBe(1);
  });

  it("default sort puts highest first-bucket count on top", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30, 60] },
    });
    // 30d+: Kanak=2, Hubern=2, Unassigned=0. Tied 2/2 — order doesn't
    // matter between Kanak/Hubern but unassigned must be last.
    expect(result.rows[result.rows.length - 1].group_key).toBe("(Unassigned)");
  });

  it("null days_since_out treated as ≥120 (worst bucket)", () => {
    const book = [
      makeCustomer({ am_name: "Solo", days_since_out: null }),
    ];
    const result = runQuery(book, {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30, 60, 90, 120, 180] },
    });
    const solo = result.rows.find((r) => r.group_key === "Solo");
    expect(solo!.bucket_counts!["180d+"]).toBe(1);
    expect(solo!.bucket_counts!["120d+"]).toBe(1);
  });
});

describe("runQuery — mrr × group_by=tier with sum buckets", () => {
  it("returns sum and avg per tier, no bucket_counts", () => {
    const result = runQuery(sampleBook(), {
      metric: "mrr",
      group_by: "tier",
      buckets: { type: "sum" },
    });

    const atRisk = result.rows.find((r) => r.group_key === "At Risk");
    expect(atRisk).toBeDefined();
    expect(atRisk!.total_customers).toBe(2); // Kanak 249 + Hubern 149
    expect(atRisk!.sum).toBe(398);
    expect(atRisk!.avg).toBe(199);
    expect(atRisk!.bucket_counts).toBeUndefined();
  });

  it("zero MRR customers don't break avg", () => {
    const book = [
      makeCustomer({ am_name: "A", tier: "Healthy", plan_amount: 0 }),
      makeCustomer({ am_name: "A", tier: "Healthy", plan_amount: 0 }),
    ];
    const result = runQuery(book, {
      metric: "mrr",
      group_by: "tier",
      buckets: { type: "sum" },
    });
    expect(result.rows[0].sum).toBe(0);
    expect(result.rows[0].avg).toBe(0);
  });
});

describe("runQuery — composite_score × group_by=stoplight with range buckets", () => {
  it("range buckets are disjoint — value lands in first match", () => {
    const result = runQuery(sampleBook(), {
      metric: "composite_score",
      group_by: "stoplight",
      buckets: {
        type: "range",
        ranges: [
          { label: "0-49", min: 0, max: 49 },
          { label: "50-79", min: 50, max: 79 },
          { label: "80-100", min: 80, max: 100 },
        ],
      },
    });
    const red = result.rows.find((r) => r.group_key === "RED");
    expect(red).toBeDefined();
    // RED customers have composites 78, 70, 88 → 70 and 78 in 50-79, 88 in 80-100
    expect(red!.total_customers).toBe(3);
    expect(red!.bucket_counts!["0-49"]).toBe(0);
    expect(red!.bucket_counts!["50-79"]).toBe(2);
    expect(red!.bucket_counts!["80-100"]).toBe(1);
  });

  it("values outside any range count toward total but not any bucket", () => {
    const book = [
      makeCustomer({ composite: 5, stoplight: "GREEN" }),
      makeCustomer({ composite: 150, stoplight: "GREEN" }),  // out-of-range high
    ];
    const result = runQuery(book, {
      metric: "composite_score",
      group_by: "stoplight",
      buckets: {
        type: "range",
        ranges: [{ label: "10-100", min: 10, max: 100 }],
      },
    });
    const green = result.rows[0];
    expect(green.total_customers).toBe(2);
    expect(green.bucket_counts!["10-100"]).toBe(0); // 5 too low, 150 too high
  });
});

// ─────────────────── group_by = none ─────────────────────

describe("runQuery — group_by=none gives a single 'all' row", () => {
  it("rolls every customer into one bucket", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "none",
      buckets: { type: "threshold", values: [30] },
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].group_key).toBe("all");
    expect(result.rows[0].total_customers).toBe(6);
  });
});

// ─────────────────── Filter clauses ───────────────────────

describe("runQuery — filter", () => {
  it("filter.am_name narrows to those AMs", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30] },
      filter: { am_name: ["Hubern C"] },
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].group_key).toBe("Hubern C");
    expect(result.total_customers_in_scope).toBe(2);
  });

  it("filter.stoplight narrows to RED only", () => {
    const result = runQuery(sampleBook(), {
      metric: "open_tickets",
      group_by: "am",
      buckets: { type: "threshold", values: [1] },
      filter: { stoplight: ["RED"] },
    });
    // RED customers: Kanak's 95-day (2 tickets), Hubern's 65-day (1), Hubern's 130-day (5) → all match ≥1 ticket
    expect(result.total_customers_in_scope).toBe(3);
    const totalAtThreshold = result.rows.reduce((sum, r) => sum + (r.bucket_counts!["1+"] ?? 0), 0);
    expect(totalAtThreshold).toBe(3);
  });

  it("multiple filter keys AND together", () => {
    const result = runQuery(sampleBook(), {
      metric: "mrr",
      group_by: "am",
      buckets: { type: "sum" },
      filter: { stoplight: ["RED"], am_name: ["Hubern C"] },
    });
    // Hubern C RED: 149 + 99 = 248
    expect(result.total_customers_in_scope).toBe(2);
    expect(result.rows[0].sum).toBe(248);
  });

  it("filter values within an array OR together (case-insensitive)", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [1] },
      filter: { am_name: ["kanak sharma", "HUBERN C"] }, // lowercased / uppercased
    });
    expect(result.total_customers_in_scope).toBe(5);
  });
});

// ─────────────────── Sorting ─────────────────────────────

describe("runQuery — sort_by", () => {
  it("sort_by='group_key' is alphabetical", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30] },
      sort_by: "group_key",
    });
    expect(result.rows.map((r) => r.group_key)).toEqual([
      "(Unassigned)",
      "Hubern C",
      "Kanak sharma",
    ]);
  });

  it("sort_by='total' is by group size desc", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30] },
      sort_by: "total",
    });
    // Kanak has 3, Hubern 2, Unassigned 1
    expect(result.rows[0].group_key).toBe("Kanak sharma");
    expect(result.rows[2].group_key).toBe("(Unassigned)");
  });
});

// ─────────────────── Limit ───────────────────────────────

describe("runQuery — limit", () => {
  it("limit caps the number of returned rows", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30] },
      limit: 1,
    });
    expect(result.rows.length).toBe(1);
    expect(result.limit).toBe(1);
  });

  it("limit defaults to 50", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30] },
    });
    expect(result.limit).toBe(50);
  });

  it("limit hard-caps at 200 (clamp)", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30] },
      limit: 9999,
    });
    expect(result.limit).toBe(200);
  });

  it("limit clamps below 1 to 1", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30] },
      limit: 0,
    });
    expect(result.limit).toBe(1);
  });
});

// ─────────────────── Edge cases ──────────────────────────

describe("runQuery — edge cases", () => {
  it("empty input returns zero rows", () => {
    const result = runQuery([], {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30] },
    });
    expect(result.rows).toEqual([]);
    expect(result.total_customers_in_scope).toBe(0);
  });

  it("group_by=pod handles '' (no pod) gracefully", () => {
    const book = [makeCustomer({ pod: "" })];
    const result = runQuery(book, {
      metric: "outbound_silence",
      group_by: "pod",
      buckets: { type: "threshold", values: [30] },
    });
    expect(result.rows[0].group_key).toBe("(Floating/Unassigned)");
  });

  it("past_due_amount converts cents to dollars via sum", () => {
    const result = runQuery(sampleBook(), {
      metric: "past_due_amount",
      group_by: "am",
      buckets: { type: "sum" },
    });
    // Kanak 24900¢ = 249, Hubern 89700¢ = 897, unassigned 0
    const kanak = result.rows.find((r) => r.group_key === "Kanak sharma");
    expect(kanak!.sum).toBe(249);
    const hubern = result.rows.find((r) => r.group_key === "Hubern C");
    expect(hubern!.sum).toBe(897);
  });

  it("filter producing zero matches returns empty rows + scope=0", () => {
    const result = runQuery(sampleBook(), {
      metric: "mrr",
      group_by: "am",
      buckets: { type: "sum" },
      filter: { am_name: ["Nonexistent Person"] },
    });
    expect(result.rows).toEqual([]);
    expect(result.total_customers_in_scope).toBe(0);
  });
});

// ────────────────────────── Tier 4 — synthetic citations ────────────────

describe("buildQueryCitations — threshold mode", () => {
  it("emits one citation per (group, bucket) plus a :total entry", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30, 60, 90, 120] },
    });
    const citations = result.citations;
    // Kanak sharma: 4 bucket entries + 1 total = 5
    // Hubern C: 4 + 1 = 5
    // (Unassigned): 4 + 1 = 5
    expect(Object.keys(citations).length).toBe(15);

    // Kanak's 30d+ entry — 2 customers (35-day, 95-day)
    const kanak30 = citations["count:query:outbound_silence:kanak_sharma:30d+"];
    expect(kanak30).toBeDefined();
    expect(kanak30.value).toBe("2");
    expect(kanak30.label).toContain("Kanak sharma");
    expect(kanak30.label).toContain("30d+");

    // Kanak's 90d+ — just the 95-day customer
    const kanak90 = citations["count:query:outbound_silence:kanak_sharma:90d+"];
    expect(kanak90.value).toBe("1");

    // Kanak's :total
    const kanakTotal = citations["count:query:outbound_silence:kanak_sharma:total"];
    expect(kanakTotal.value).toBe("3");
  });

  it("slugs group keys with non-alphanumerics → underscores", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30] },
    });
    // "(Unassigned)" should slug to "unassigned"
    const unassignedKey = "count:query:outbound_silence:unassigned:30d+";
    expect(result.citations[unassignedKey]).toBeDefined();
  });

  it("raw payload includes group_key + bucket + total_customers", () => {
    const result = runQuery(sampleBook(), {
      metric: "outbound_silence",
      group_by: "am",
      buckets: { type: "threshold", values: [30] },
    });
    const entry = result.citations["count:query:outbound_silence:hubern_c:30d+"];
    expect(entry.raw).toMatchObject({
      group_key: "Hubern C",
      metric: "outbound_silence",
      bucket: "30d+",
      total_customers: 2,
    });
  });
});

describe("buildQueryCitations — sum mode", () => {
  it("emits :sum, :avg, and :total per group (no bucket entries)", () => {
    const result = runQuery(sampleBook(), {
      metric: "mrr",
      group_by: "tier",
      buckets: { type: "sum" },
    });
    const citations = result.citations;

    // At Risk has 2 customers: 249 + 149 = 398, avg 199
    const atRiskSum = citations["count:query:mrr:at_risk:sum"];
    expect(atRiskSum).toBeDefined();
    expect(atRiskSum.value).toBe("398");

    const atRiskAvg = citations["count:query:mrr:at_risk:avg"];
    expect(atRiskAvg.value).toBe("199");

    const atRiskTotal = citations["count:query:mrr:at_risk:total"];
    expect(atRiskTotal.value).toBe("2");

    // No bucket entries for sum mode
    expect(citations["count:query:mrr:at_risk:30d+"]).toBeUndefined();
  });
});

describe("buildQueryCitations — direct call", () => {
  it("works without going through runQuery", () => {
    const citations = buildQueryCitations({
      metric: "outbound_silence",
      rows: [
        {
          group_key: "Test AM",
          total_customers: 5,
          bucket_counts: { "30d+": 3, "60d+": 1 },
        },
      ],
      labels: ["30d+", "60d+"],
      isSum: false,
    });
    expect(citations["count:query:outbound_silence:test_am:30d+"].value).toBe("3");
    expect(citations["count:query:outbound_silence:test_am:60d+"].value).toBe("1");
    expect(citations["count:query:outbound_silence:test_am:total"].value).toBe("5");
  });
});
