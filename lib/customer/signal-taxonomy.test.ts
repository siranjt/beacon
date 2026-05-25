/**
 * Phase E-15.5 — signal-taxonomy tests.
 *
 * customerHasSignal is the single predicate used by V2AMTriage's filter
 * pills, V2CustomerCard's chip click handlers, and Beacon AI's signal
 * counting. If a threshold drifts here, the entire app silently
 * mis-classifies which customers belong to which signal bucket.
 *
 * Documented thresholds (matching the implementation):
 *   client_silent / we_silent / resp_drop:  >= 65
 *   vol_collapse / usage_low:               >= 55
 *   billing:                                >= 40
 *   perf_flag:                              boolean flag_performance
 */

import { describe, it, expect } from "vitest";
import {
  SIGNAL_KEYS,
  SIGNAL_LABELS,
  isSignalKey,
  customerHasSignal,
  type SignalKey,
} from "./signal-taxonomy";
import type { ScoredCustomerV2, CustomerSignalsV2 } from "./types";

function signals(over: Partial<CustomerSignalsV2> = {}): CustomerSignalsV2 {
  return {
    composite: 0,
    tier: "HEALTHY",
    stoplight: "GREEN",
    sig_we_silent: 0,
    sig_client_silent: 0,
    sig_response_drop: 0,
    sig_volume_collapse: 0,
    sig_usage: 0,
    sig_billing: 0,
    flag_performance: false,
    flag_tickets: false,
    flag_count: 0,
    trajectory_7d: "unknown",
    composite_7d_ago: null,
    reason_one_line: "",
    suggested_action: "",
    notes: "",
    pre_launch: false,
    ...over,
  };
}

function customer(over: Partial<CustomerSignalsV2> = {}): ScoredCustomerV2 {
  // Minimal stub — customerHasSignal only reads `signals_v2`.
  return {
    signals_v2: signals(over),
  } as unknown as ScoredCustomerV2;
}

describe("SIGNAL_KEYS + SIGNAL_LABELS — schema integrity", () => {
  it("every key has a corresponding label", () => {
    for (const k of SIGNAL_KEYS) {
      expect(SIGNAL_LABELS[k]).toBeDefined();
      expect(SIGNAL_LABELS[k].length).toBeGreaterThan(0);
    }
  });

  it("no extra labels not in SIGNAL_KEYS (no orphans)", () => {
    const labelKeys = Object.keys(SIGNAL_LABELS);
    expect(labelKeys.length).toBe(SIGNAL_KEYS.length);
  });

  it("SIGNAL_KEYS has 7 entries (the documented taxonomy)", () => {
    expect(SIGNAL_KEYS.length).toBe(7);
  });
});

describe("isSignalKey", () => {
  it("returns true for every key in SIGNAL_KEYS", () => {
    for (const k of SIGNAL_KEYS) {
      expect(isSignalKey(k)).toBe(true);
    }
  });

  it("returns false for unknown strings", () => {
    expect(isSignalKey("garbage")).toBe(false);
    expect(isSignalKey("Client silent")).toBe(false); // label form, not key
  });

  it("returns false for null + undefined + empty", () => {
    expect(isSignalKey(null)).toBe(false);
    expect(isSignalKey(undefined)).toBe(false);
    expect(isSignalKey("")).toBe(false);
  });
});

describe("customerHasSignal — threshold matrix", () => {
  const matrix: Array<{
    signal: SignalKey;
    field: keyof CustomerSignalsV2;
    threshold: number;
  }> = [
    { signal: "client_silent", field: "sig_client_silent", threshold: 65 },
    { signal: "we_silent", field: "sig_we_silent", threshold: 65 },
    { signal: "resp_drop", field: "sig_response_drop", threshold: 65 },
    { signal: "vol_collapse", field: "sig_volume_collapse", threshold: 55 },
    { signal: "usage_low", field: "sig_usage", threshold: 55 },
    { signal: "billing", field: "sig_billing", threshold: 40 },
  ];

  for (const m of matrix) {
    describe(m.signal, () => {
      it(`fires AT threshold (${m.threshold})`, () => {
        const c = customer({ [m.field]: m.threshold } as Partial<CustomerSignalsV2>);
        expect(customerHasSignal(c, m.signal)).toBe(true);
      });

      it(`fires ABOVE threshold (${m.threshold + 1})`, () => {
        const c = customer({ [m.field]: m.threshold + 1 } as Partial<CustomerSignalsV2>);
        expect(customerHasSignal(c, m.signal)).toBe(true);
      });

      it(`does NOT fire BELOW threshold (${m.threshold - 1})`, () => {
        const c = customer({ [m.field]: m.threshold - 1 } as Partial<CustomerSignalsV2>);
        expect(customerHasSignal(c, m.signal)).toBe(false);
      });
    });
  }
});

describe("customerHasSignal — perf_flag (boolean, not threshold)", () => {
  it("fires when flag_performance is true", () => {
    expect(customerHasSignal(customer({ flag_performance: true }), "perf_flag")).toBe(true);
  });

  it("does not fire when flag_performance is false", () => {
    expect(customerHasSignal(customer({ flag_performance: false }), "perf_flag")).toBe(false);
  });
});

describe("customerHasSignal — null-safety", () => {
  it("returns false when signals_v2 is missing entirely", () => {
    const c = {} as unknown as ScoredCustomerV2;
    expect(customerHasSignal(c, "client_silent")).toBe(false);
  });
});
