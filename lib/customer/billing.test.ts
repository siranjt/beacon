/**
 * Phase E-15.3 — billing.ts tests.
 *
 * scoreBilling drives the billing pillar of the v2 composite (20% weight)
 * and is the trigger for the "billing crisis" YELLOW override in
 * tierToStoplight. Boundary errors here misclassify customers — a real-
 * money bug class. Locking the thresholds down with explicit tests.
 *
 * Thresholds (lib/customer/config.ts BILLING_THRESHOLDS):
 *   unpaidCount: high=3, med=2, low=1 → scores 100 / 70 / 40
 *   daysOverdue: high=30, med=15, low=7 → scores 100 / 70 / 40
 *   autoDebitOffWithFailures → 100 binary
 *   ACH in-progress → -15 modifier (post-clamp)
 *
 * Composite: unpaid*0.4 + overdue*0.3 + autoFail*0.2 (10% reserved).
 */

import { describe, it, expect } from "vitest";
import { scoreBilling } from "./billing";
import type { BillingMetrics } from "./types";

function bm(over: Partial<BillingMetrics> = {}): BillingMetrics {
  return {
    entity_id: "e",
    customer_id: "c",
    unpaid_invoice_count: 0,
    total_amount_due_cents: 0,
    days_past_oldest_unpaid: 0,
    has_ach_in_progress: false,
    auto_debit_off_with_failures: false,
    recent_failed_transaction_count: 0,
    ...over,
  };
}

describe("scoreBilling — null / clean cases", () => {
  it("returns 0 when input is null (no billing metrics fetched)", () => {
    expect(scoreBilling(null)).toBe(0);
  });

  it("returns 0 when all metrics are clean", () => {
    expect(scoreBilling(bm())).toBe(0);
  });
});

describe("scoreBilling — unpaid count thresholds", () => {
  it("1 unpaid → 40 sub-score → composite 16", () => {
    // unpaid=40 * 0.4 = 16; overdue=0; autoFail=0 → 16
    expect(scoreBilling(bm({ unpaid_invoice_count: 1 }))).toBe(16);
  });

  it("2 unpaid → 70 sub-score → composite 28", () => {
    expect(scoreBilling(bm({ unpaid_invoice_count: 2 }))).toBe(28);
  });

  it("3+ unpaid → 100 sub-score → composite 40", () => {
    expect(scoreBilling(bm({ unpaid_invoice_count: 3 }))).toBe(40);
    expect(scoreBilling(bm({ unpaid_invoice_count: 7 }))).toBe(40);
  });
});

describe("scoreBilling — days-overdue thresholds", () => {
  it("7d overdue → 40 sub-score → composite 12", () => {
    // overdue=40 * 0.3 = 12
    expect(scoreBilling(bm({ days_past_oldest_unpaid: 7 }))).toBe(12);
  });

  it("15d overdue → 70 sub-score → composite 21", () => {
    expect(scoreBilling(bm({ days_past_oldest_unpaid: 15 }))).toBe(21);
  });

  it("30d+ overdue → 100 sub-score → composite 30", () => {
    expect(scoreBilling(bm({ days_past_oldest_unpaid: 30 }))).toBe(30);
    expect(scoreBilling(bm({ days_past_oldest_unpaid: 90 }))).toBe(30);
  });
});

describe("scoreBilling — auto-debit-off + failures", () => {
  it("auto-debit off WITHOUT failures does not contribute", () => {
    // The field is auto_debit_off_with_failures; flag means BOTH conditions met.
    // Field=false → autoFail = 0.
    expect(scoreBilling(bm({ auto_debit_off_with_failures: false }))).toBe(0);
  });

  it("auto-debit off WITH failures → 100 sub-score → composite 20", () => {
    expect(scoreBilling(bm({ auto_debit_off_with_failures: true }))).toBe(20);
  });
});

describe("scoreBilling — composite stacking", () => {
  it("3 unpaid + 30d overdue + auto-debit-off-with-failures → max 90", () => {
    // 40 + 30 + 20 = 90
    expect(
      scoreBilling(
        bm({
          unpaid_invoice_count: 5,
          days_past_oldest_unpaid: 45,
          auto_debit_off_with_failures: true,
        }),
      ),
    ).toBe(90);
  });

  it("mid-band combination: 2 unpaid + 15d overdue → 49", () => {
    // 70*0.4 + 70*0.3 = 28 + 21 = 49
    expect(
      scoreBilling(bm({ unpaid_invoice_count: 2, days_past_oldest_unpaid: 15 })),
    ).toBe(49);
  });
});

describe("scoreBilling — ACH in-progress discount", () => {
  it("subtracts 15 when ACH is in progress", () => {
    // 90 base - 15 ACH = 75
    const score = scoreBilling(
      bm({
        unpaid_invoice_count: 3,
        days_past_oldest_unpaid: 30,
        auto_debit_off_with_failures: true,
        has_ach_in_progress: true,
      }),
    );
    expect(score).toBe(75);
  });

  it("clamps at 0 — ACH discount can't drive composite negative", () => {
    // Clean billing + ACH in progress shouldn't go below 0.
    expect(scoreBilling(bm({ has_ach_in_progress: true }))).toBe(0);
  });
});

describe("scoreBilling — output contract", () => {
  it("always returns an integer (Math.round in implementation)", () => {
    const score = scoreBilling(
      bm({ unpaid_invoice_count: 1, days_past_oldest_unpaid: 7 }),
    );
    expect(Number.isInteger(score)).toBe(true);
  });

  it("always returns a value in [0, 100]", () => {
    // Worst case
    const max = scoreBilling(
      bm({
        unpaid_invoice_count: 99,
        days_past_oldest_unpaid: 999,
        auto_debit_off_with_failures: true,
      }),
    );
    expect(max).toBeLessThanOrEqual(100);
    expect(max).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Phase E-15.5 — buildBillingMetrics aggregator tests.
//
// Takes raw Chargebee arrays (invoices, transactions, subs) plus the
// customer→entities map and produces one BillingMetrics row per entity.
// This is where the entity-fan-out happens (multi-location customers share
// one customer_id but get separate billing rows). Easy class of bug:
// double-counting, missing fan-out, or wrong direction of the auto-debit
// OR-reduce across multiple subs.
// ---------------------------------------------------------------------------

import { buildBillingMetrics } from "./billing";
import type {
  ChargebeeInvoice,
  ChargebeeTransaction,
  ChargebeeSub,
} from "./types";

function inv(over: Partial<ChargebeeInvoice> = {}): ChargebeeInvoice {
  return {
    invoice_id: "inv_1",
    customer_id: "cust_1",
    amount_due: 1000,
    days_overdue: 0,
    ...over,
  } as ChargebeeInvoice;
}

function tx(over: Partial<ChargebeeTransaction> = {}): ChargebeeTransaction {
  return {
    id: "tx_1",
    customer_id: "cust_1",
    // Transactions Beacon cares about are either "failure" (counted as
    // recent failed) or "in_progress" (gates the ACH-in-progress flag).
    // "success" isn't surfaced — the count only includes failures.
    status: "failure",
    amount: 100,
    date: Math.floor(Date.now() / 1000),
    linked_invoice_ids: [],
    ...over,
  };
}

function sub(over: Partial<ChargebeeSub> = {}): ChargebeeSub {
  return {
    subscription_id: "sub_1",
    customer_id: "cust_1",
    status: "active",
    auto_collection: "on",
    ...over,
  } as ChargebeeSub;
}

describe("buildBillingMetrics — fan-out + aggregation", () => {
  it("returns empty map when no customer→entities entries", () => {
    const out = buildBillingMetrics([], [], [], new Map());
    expect(out.size).toBe(0);
  });

  it("fans one customer's invoices out to multiple entity_ids", () => {
    // Multi-location customer: one cust_id → 3 entities. Each entity gets
    // its own BillingMetrics row referencing the same parent customer.
    const customerToEntities = new Map([["cust_1", ["ent_a", "ent_b", "ent_c"]]]);
    const out = buildBillingMetrics(
      [inv({ amount_due: 500 }), inv({ invoice_id: "inv_2", amount_due: 700 })],
      [],
      [],
      customerToEntities,
    );
    expect(out.size).toBe(3);
    expect(out.get("ent_a")?.unpaid_invoice_count).toBe(2);
    expect(out.get("ent_a")?.total_amount_due_cents).toBe(1200);
    // All three entities reference the same customer + aggregate.
    expect(out.get("ent_b")?.total_amount_due_cents).toBe(1200);
    expect(out.get("ent_c")?.total_amount_due_cents).toBe(1200);
  });

  it("uses MAX of days_overdue across invoices (oldest unpaid)", () => {
    const out = buildBillingMetrics(
      [
        inv({ days_overdue: 5 }),
        inv({ invoice_id: "inv_2", days_overdue: 22 }),
        inv({ invoice_id: "inv_3", days_overdue: 14 }),
      ],
      [],
      [],
      new Map([["cust_1", ["ent_1"]]]),
    );
    expect(out.get("ent_1")?.days_past_oldest_unpaid).toBe(22);
  });

  it("counts failed transactions only (not in_progress)", () => {
    // The ChargebeeTransaction type only tracks 'failure' and 'in_progress'
    // statuses — 'success' isn't surfaced by the upstream fetch at all.
    // Failure count drives the auto-debit-off-with-failures flag.
    const out = buildBillingMetrics(
      [],
      [
        tx({ status: "failure" }),
        tx({ id: "tx_2", status: "failure" }),
        tx({ id: "tx_3", status: "failure" }),
        tx({ id: "tx_4", status: "in_progress" }),
      ],
      [],
      new Map([["cust_1", ["ent_1"]]]),
    );
    expect(out.get("ent_1")?.recent_failed_transaction_count).toBe(3);
  });

  it("auto_debit_off_with_failures requires BOTH conditions on same customer", () => {
    const customerToEntities = new Map([["cust_1", ["ent_1"]]]);
    // Auto-debit off, but no failures → false
    const justOff = buildBillingMetrics(
      [],
      [],
      [sub({ auto_collection: "off" })],
      customerToEntities,
    );
    expect(justOff.get("ent_1")?.auto_debit_off_with_failures).toBe(false);

    // Failures, but auto-debit on → false
    const justFailures = buildBillingMetrics(
      [],
      [tx({ status: "failure" })],
      [sub({ auto_collection: "on" })],
      customerToEntities,
    );
    expect(justFailures.get("ent_1")?.auto_debit_off_with_failures).toBe(false);

    // BOTH → true
    const both = buildBillingMetrics(
      [],
      [tx({ status: "failure" })],
      [sub({ auto_collection: "off" })],
      customerToEntities,
    );
    expect(both.get("ent_1")?.auto_debit_off_with_failures).toBe(true);
  });

  it("auto_debit_off across multiple subs is OR-reduced (any off ⇒ off)", () => {
    // If a customer has two subs, one with auto on and one with auto off,
    // the customer is considered "auto debit off" for the failure check.
    const customerToEntities = new Map([["cust_1", ["ent_1"]]]);
    const out = buildBillingMetrics(
      [],
      [tx({ status: "failure" })],
      [
        sub({ subscription_id: "sub_a", auto_collection: "on" }),
        sub({ subscription_id: "sub_b", auto_collection: "off" }),
      ],
      customerToEntities,
    );
    expect(out.get("ent_1")?.auto_debit_off_with_failures).toBe(true);
  });

  it("flags has_ach_in_progress when in_progress tx links to an unpaid invoice", () => {
    const customerToEntities = new Map([["cust_1", ["ent_1"]]]);
    const out = buildBillingMetrics(
      [inv({ invoice_id: "inv_a" })],
      [tx({ status: "in_progress", linked_invoice_ids: ["inv_a"] })],
      [],
      customerToEntities,
    );
    expect(out.get("ent_1")?.has_ach_in_progress).toBe(true);
  });

  it("does NOT flag has_ach_in_progress when in_progress tx points elsewhere", () => {
    const customerToEntities = new Map([["cust_1", ["ent_1"]]]);
    const out = buildBillingMetrics(
      [inv({ invoice_id: "inv_a" })],
      [
        tx({
          status: "in_progress",
          linked_invoice_ids: ["inv_unrelated"],
        }),
      ],
      [],
      customerToEntities,
    );
    expect(out.get("ent_1")?.has_ach_in_progress).toBe(false);
  });

  it("ignores rows with empty customer_id (defensive)", () => {
    const out = buildBillingMetrics(
      [inv({ customer_id: "" })],
      [tx({ customer_id: "" })],
      [sub({ customer_id: "" })],
      new Map([["cust_1", ["ent_1"]]]),
    );
    // No data lands on ent_1 because no rows had matching customer_id.
    expect(out.get("ent_1")?.unpaid_invoice_count).toBe(0);
    expect(out.get("ent_1")?.recent_failed_transaction_count).toBe(0);
  });

  it("writes the BillingMetrics shape correctly (entity_id + customer_id + all numerics)", () => {
    const out = buildBillingMetrics(
      [inv({ amount_due: 1234, days_overdue: 7 })],
      [tx({ status: "failure" })],
      [sub({ auto_collection: "off" })],
      new Map([["cust_1", ["ent_1"]]]),
    );
    const m = out.get("ent_1")!;
    expect(m.entity_id).toBe("ent_1");
    expect(m.customer_id).toBe("cust_1");
    expect(m.unpaid_invoice_count).toBe(1);
    expect(m.total_amount_due_cents).toBe(1234);
    expect(m.days_past_oldest_unpaid).toBe(7);
    expect(m.recent_failed_transaction_count).toBe(1);
    expect(m.auto_debit_off_with_failures).toBe(true);
    expect(m.has_ach_in_progress).toBe(false);
  });
});
