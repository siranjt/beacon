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
