/**
 * Phase E-13 — first tests, target #2: scoring.ts.
 *
 * scoreCustomer + computeMetrics power the entire RED / YELLOW / GREEN
 * book classification an AM sees on every page load. A miscalibration here
 * silently changes who's in their queue. These tests fence the boundary
 * thresholds + the documented edge cases (zero comms baseline, watch lane,
 * billing override) so future tuning can't regress them by accident.
 *
 * Constants we rely on (from lib/customer/config.ts — replicated here so
 * a test break flags the boundary change, not just a config drift):
 *   TIER_CUTS:           high=65, medium=35, low=15
 *   WE_SILENT_DAYS:      high=60, med=30, low=14
 *   CLIENT_SILENT_DAYS:  high=45, med=30, low=14
 *   ZERO_COMMS_BASELINE: 85
 *   SIG_WEIGHTS:         30 / 30 / 25 / 15 (we / client / response / volume)
 */

import { describe, it, expect } from "vitest";
import { computeMetrics, scoreCustomer } from "./scoring";
import type { CommsEvent } from "./types";

// Canonical "today" — Mon May 26 2026 00:00 UTC. All ages are computed
// against this to keep tests deterministic.
const TODAY = Date.parse("2026-05-26T00:00:00Z");
const DAY = 86_400_000;

/** Helper: synthesize a comms event N days ago. */
function event(daysAgo: number, opts: Partial<CommsEvent> = {}): CommsEvent {
  return {
    ts: TODAY - daysAgo * DAY,
    channel: "email",
    direction: "in",
    ...opts,
  } as CommsEvent;
}

describe("computeMetrics — window bucketing", () => {
  it("counts events into the right rolling windows", () => {
    const m = computeMetrics(
      [
        event(3, { direction: "out" }), // in 7d, 14d, 30d, 60d, 90d
        event(10, { direction: "in" }), // in 14d, 30d, 60d, 90d
        event(45, { direction: "out" }), // in 60d, 90d
        event(80, { direction: "in" }), // in 90d only
      ],
      TODAY,
    );
    expect(m.total_7d).toBe(1);
    expect(m.total_14d).toBe(2);
    expect(m.total_30d).toBe(2);
    expect(m.total_60d).toBe(3);
    expect(m.total_90d).toBe(4);
  });

  it("counts direction independently", () => {
    const m = computeMetrics(
      [event(5, { direction: "in" }), event(5, { direction: "out" }), event(5, { direction: "in" })],
      TODAY,
    );
    expect(m.in_7d).toBe(2);
    expect(m.out_7d).toBe(1);
  });

  it("tracks distinct channels per window", () => {
    const m = computeMetrics(
      [
        event(2, { channel: "email" }),
        event(2, { channel: "chat" }),
        event(2, { channel: "phone" }),
        event(2, { channel: "email" }), // duplicate channel; should not double-count
      ],
      TODAY,
    );
    expect(m.channels_7d).toBe(3);
    expect(m.channels_used_30d).toBe("chat,email,phone");
  });

  it("returns 9999 days_since when no events of that direction exist", () => {
    const m = computeMetrics([event(5, { direction: "in" })], TODAY);
    expect(m.days_since_in).toBe(5);
    expect(m.days_since_out).toBe(9999);
  });

  it("returns zero metrics for an empty input", () => {
    const m = computeMetrics([], TODAY);
    expect(m.total_90d).toBe(0);
    expect(m.in_90d).toBe(0);
    expect(m.out_90d).toBe(0);
    expect(m.days_since_in).toBe(9999);
    expect(m.days_since_out).toBe(9999);
    expect(m.last_any_iso).toBeNull();
  });
});

describe("scoreCustomer — zero-comms baseline", () => {
  it("zero 90d comms → composite hits 85 baseline regardless", () => {
    const m = computeMetrics([], TODAY);
    const s = scoreCustomer(m);
    expect(s.score).toBeGreaterThanOrEqual(85);
    expect(s.tier).toBe("HIGH"); // zero-comms always HIGH per tierFor()
    expect(s.notes).toContain("Zero comms in 90d");
  });
});

describe("scoreCustomer — we-silent signal", () => {
  it("fires HIGH (100) at ≥ 60 days since outbound", () => {
    // Inbound only, no outbound — days_since_out = 9999
    const m = computeMetrics([event(2, { direction: "in" })], TODAY);
    const s = scoreCustomer(m);
    expect(s.sig_we_silent).toBe(100);
    expect(s.notes).toMatch(/We haven't reached out/);
  });

  it("fires MED (70) at 30 ≤ dso < 60", () => {
    const m = computeMetrics(
      [event(2, { direction: "in" }), event(35, { direction: "out" })],
      TODAY,
    );
    const s = scoreCustomer(m);
    expect(s.sig_we_silent).toBe(70);
  });

  it("fires LOW (30) at 14 ≤ dso < 30", () => {
    const m = computeMetrics(
      [event(2, { direction: "in" }), event(20, { direction: "out" })],
      TODAY,
    );
    const s = scoreCustomer(m);
    expect(s.sig_we_silent).toBe(30);
  });

  it("does NOT fire when dso < 14", () => {
    const m = computeMetrics(
      [event(2, { direction: "out" })],
      TODAY,
    );
    const s = scoreCustomer(m);
    expect(s.sig_we_silent).toBe(0);
  });
});

describe("scoreCustomer — client-silent signal", () => {
  it("requires history (inbound 30-90d ago) before firing", () => {
    // No inbound history at all → guard should suppress the signal
    const m = computeMetrics(
      [event(2, { direction: "out" })],
      TODAY,
    );
    const s = scoreCustomer(m);
    expect(s.sig_client_silent).toBe(0);
  });

  it("fires HIGH (100) at ≥ 45 days since inbound, given prior history", () => {
    const m = computeMetrics(
      [
        event(60, { direction: "in" }),
        event(50, { direction: "in" }),
        event(2, { direction: "out" }),
      ],
      TODAY,
    );
    const s = scoreCustomer(m);
    expect(s.sig_client_silent).toBe(100);
  });
});

describe("scoreCustomer — tier classification thresholds", () => {
  it("composite ≥ 65 → HIGH", () => {
    // Goal: drive three signals to land ≥ 65.
    //   we-silent 100  (30)  — last outbound 70d ago
    //   client-silent 100 (30) — last inbound 50d ago with prior history
    //   volume-collapse 60 (9) — channels narrowed from 3 → 0
    //   total = 69 → HIGH (≥ 65)
    //
    // Customer was active across email/chat/phone in the 60-90d window, then
    // went completely silent in the last 30 days. Classic dormant pattern.
    const m = computeMetrics(
      [
        event(80, { direction: "in", channel: "email" }),
        event(75, { direction: "in", channel: "chat" }),
        event(70, { direction: "out", channel: "phone" }),
        event(65, { direction: "in", channel: "email" }), // gives history for client-silent guard
        event(50, { direction: "in", channel: "email" }), // dsi=50 → client-silent HIGH (100)
      ],
      TODAY,
    );
    const s = scoreCustomer(m);
    expect(s.tier).toBe("HIGH");
    expect(s.score).toBeGreaterThanOrEqual(65);
  });

  it("composite 35..64 → MEDIUM", () => {
    // Drive a mid-band composite via one strong signal + a weak one.
    // we-silent MED (70) at weight 0.30 = 21
    // client-silent MED (70) at weight 0.30 = 21
    // Total ~42 → MEDIUM band
    const m = computeMetrics(
      [
        event(80, { direction: "in" }), // history for client-silent guard
        event(50, { direction: "in" }), // dsi ~ 50 → would be HIGH, so pick 35 instead
      ],
      Date.parse("2026-05-26T00:00:00Z"),
    );
    // Recompute with a tuned event set that lands in MED band:
    const m2 = computeMetrics(
      [
        event(80, { direction: "in" }), // history
        event(35, { direction: "in" }), // dsi=35 → MED (70)
        event(35, { direction: "out" }), // dso=35 → MED (70)
      ],
      TODAY,
    );
    const s = scoreCustomer(m2);
    expect(s.score).toBeGreaterThanOrEqual(35);
    expect(s.score).toBeLessThan(65);
    expect(s.tier).toBe("MEDIUM");
    // Touch m so unused-var lint is happy.
    expect(m.total_90d).toBeGreaterThanOrEqual(0);
  });

  it("composite 15..34 → LOW", () => {
    // we-silent LOW (30) at weight 0.30 = 9 — too low.
    // Need we-silent MED (70) * 0.30 = 21 → LOW band.
    const m = computeMetrics(
      [
        event(35, { direction: "out" }), // dso=35 → MED (70). Score = 70*0.30=21.
      ],
      TODAY,
    );
    const s = scoreCustomer(m);
    expect(s.score).toBeGreaterThanOrEqual(15);
    expect(s.score).toBeLessThan(35);
    expect(s.tier).toBe("LOW");
  });

  it("composite < 15 with non-zero 90d comms → HEALTHY", () => {
    // Active customer, no triggered signals
    const m = computeMetrics(
      [
        event(2, { direction: "in" }),
        event(3, { direction: "out" }),
        event(4, { direction: "in" }),
      ],
      TODAY,
    );
    const s = scoreCustomer(m);
    expect(s.score).toBeLessThan(15);
    expect(s.tier).toBe("HEALTHY");
  });
});

describe("scoreCustomer — return shape contract", () => {
  it("always returns all signal fields + notes string", () => {
    const m = computeMetrics([event(2, { direction: "in" })], TODAY);
    const s = scoreCustomer(m);
    expect(s).toHaveProperty("score");
    expect(s).toHaveProperty("tier");
    expect(s).toHaveProperty("sig_we_silent");
    expect(s).toHaveProperty("sig_client_silent");
    expect(s).toHaveProperty("sig_response_drop");
    expect(s).toHaveProperty("sig_volume_collapse");
    expect(typeof s.notes).toBe("string");
  });

  it("score is an integer (Math.round in implementation)", () => {
    const m = computeMetrics(
      [event(45, { direction: "out" }), event(45, { direction: "in" })],
      TODAY,
    );
    const s = scoreCustomer(m);
    expect(Number.isInteger(s.score)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase E-15.3 additions — computeTicketsFlag + composeHybridSignals + edge
// cases. These functions sit downstream of scoreCustomer and feed the final
// CustomerSignalsV2 the V2CustomerCard reads.
// ---------------------------------------------------------------------------

import { computeTicketsFlag, composeHybridSignals } from "./scoring";
import type {
  CustomerSignals,
  PerformanceMetrics,
  TicketsMetrics,
  BillingMetrics,
} from "./types";

describe("computeTicketsFlag — OR of two BaseSheet counters", () => {
  it("zero on both → flag false", () => {
    const t = computeTicketsFlag("e1", 0, 0);
    expect(t.flag).toBe(false);
    expect(t.open_tickets_30d).toBe(0);
    expect(t.unresolved_issues_last_30_days).toBe(0);
  });

  it("any open tickets → flag true", () => {
    expect(computeTicketsFlag("e1", 1, 0).flag).toBe(true);
    expect(computeTicketsFlag("e1", 5, 0).flag).toBe(true);
  });

  it("any unresolved issues → flag true even with zero open tickets", () => {
    expect(computeTicketsFlag("e1", 0, 1).flag).toBe(true);
    expect(computeTicketsFlag("e1", 0, 3).flag).toBe(true);
  });

  it("both populated → flag true (no double-counting concern)", () => {
    expect(computeTicketsFlag("e1", 2, 4).flag).toBe(true);
  });
});

// Test helper: minimal CustomerSignals stub (we don't re-run scoreCustomer
// because composeHybridSignals takes its output as input, not its input).
function commsSignalsStub(
  over: Partial<CustomerSignals> = {},
): CustomerSignals {
  return {
    score: 0,
    tier: "HEALTHY",
    sig_we_silent: 0,
    sig_client_silent: 0,
    sig_response_drop: 0,
    sig_volume_collapse: 0,
    notes: "",
    ...over,
  };
}

function cleanCommsMetrics() {
  // Always-active customer — no signals firing
  return computeMetrics(
    [event(2, { direction: "in" }), event(3, { direction: "out" })],
    TODAY,
  );
}

function zeroCommsMetrics() {
  return computeMetrics([], TODAY);
}

describe("composeHybridSignals — pre-launch path", () => {
  it("pre-launch customers get a neutral HEALTHY/GREEN with composite=50", () => {
    const s = composeHybridSignals({
      commsSignals: commsSignalsStub(),
      usageScore: 0,
      billingScore: 0,
      performance: null,
      tickets: null,
      commsMetrics: zeroCommsMetrics(),
      mixpanelHasData: false,
      preLaunch: true,
    });
    expect(s.tier).toBe("HEALTHY");
    expect(s.stoplight).toBe("GREEN");
    expect(s.composite).toBe(50);
    expect(s.pre_launch).toBe(true);
    expect(s.reason_one_line).toMatch(/Pre-launch/i);
    // All sub-signals zeroed — pre-launch customers shouldn't have churn signals.
    expect(s.sig_we_silent).toBe(0);
    expect(s.sig_client_silent).toBe(0);
    expect(s.sig_billing).toBe(0);
  });
});

describe("composeHybridSignals — zero-comms + no Mixpanel auto-HIGH override", () => {
  it("forces HIGH tier when comms_90d=0 AND mixpanel has no data", () => {
    const s = composeHybridSignals({
      commsSignals: commsSignalsStub(),
      usageScore: 0,
      billingScore: 0,
      performance: null,
      tickets: null,
      commsMetrics: zeroCommsMetrics(),
      mixpanelHasData: false,
      preLaunch: false,
    });
    expect(s.tier).toBe("HIGH");
    expect(s.stoplight).toBe("RED");
  });

  it("does NOT force HIGH when zero comms but mixpanel data exists (coverage gap not churn signal)", () => {
    const s = composeHybridSignals({
      commsSignals: commsSignalsStub(),
      usageScore: 0,
      billingScore: 0,
      performance: null,
      tickets: null,
      commsMetrics: zeroCommsMetrics(),
      mixpanelHasData: true,
      preLaunch: false,
    });
    // Without no-mixpanel override, tier is purely composite-driven.
    expect(s.tier).not.toBe("HIGH");
  });
});

describe("composeHybridSignals — billing crisis YELLOW override", () => {
  it("strong billing score lifts otherwise-GREEN customer to YELLOW", () => {
    const billing: BillingMetrics = {
      entity_id: "e1",
      customer_id: "c1",
      unpaid_invoice_count: 5,
      total_amount_due_cents: 50000,
      days_past_oldest_unpaid: 45,
      has_ach_in_progress: false,
      auto_debit_off_with_failures: true,
      recent_failed_transaction_count: 3,
    };
    const s = composeHybridSignals({
      commsSignals: commsSignalsStub(),
      usageScore: 0,
      billingScore: 90, // billing crisis level
      billing,
      performance: null,
      tickets: null,
      commsMetrics: cleanCommsMetrics(),
      mixpanelHasData: true,
      preLaunch: false,
    });
    // Billing override should at minimum lift to YELLOW.
    expect(["YELLOW", "RED"]).toContain(s.stoplight);
    expect(s.sig_billing).toBe(90);
  });
});

describe("composeHybridSignals — WATCH lane (2+ modifier flags lift HEALTHY/LOW to YELLOW)", () => {
  it("HEALTHY customer with 2 flags surfaces as YELLOW via WATCH lane", () => {
    const performance: PerformanceMetrics = {
      entity_id: "e1",
      gbp_clicks_peak_complete_month: 100,
      gbp_clicks_current_complete_month: 50,
      gbp_clicks_in_progress_month: null,
      gbp_clicks_drop_pct: 50,
      ytd_leads: null,
      prior_ytd_leads: null,
      ytd_leads_change_pct: null,
      active_ranking_count: null,
      rankings_top_3: null,
      rankings_top_10: null,
      rankings_outside_10: null,
      reviews_last_12_weeks_total: null,
      weeks_with_zero_reviews: null,
      review_target_weekly: null,
      flag: true,
      flag_reasons: ["GBP clicks -50%"],
    };
    const tickets: TicketsMetrics = {
      entity_id: "e1",
      open_tickets_30d: 3,
      unresolved_issues_last_30_days: 0,
      flag: true,
    };
    const s = composeHybridSignals({
      commsSignals: commsSignalsStub(),
      usageScore: 0,
      billingScore: 0,
      performance,
      tickets,
      commsMetrics: cleanCommsMetrics(),
      mixpanelHasData: true,
      preLaunch: false,
    });
    expect(s.flag_performance).toBe(true);
    expect(s.flag_tickets).toBe(true);
    expect(s.flag_count).toBe(2);
    // WATCH lane: 2 flags + HEALTHY underlying tier → YELLOW
    expect(s.stoplight).toBe("YELLOW");
  });
});

describe("composeHybridSignals — full sub-signal pass-through", () => {
  it("comms sub-scores from input commsSignals land on output unchanged", () => {
    const stub = commsSignalsStub({
      sig_we_silent: 70,
      sig_client_silent: 100,
      sig_response_drop: 40,
      sig_volume_collapse: 60,
    });
    const s = composeHybridSignals({
      commsSignals: stub,
      usageScore: 30,
      billingScore: 20,
      performance: null,
      tickets: null,
      commsMetrics: cleanCommsMetrics(),
      mixpanelHasData: true,
      preLaunch: false,
    });
    expect(s.sig_we_silent).toBe(70);
    expect(s.sig_client_silent).toBe(100);
    expect(s.sig_response_drop).toBe(40);
    expect(s.sig_volume_collapse).toBe(60);
    expect(s.sig_usage).toBe(30);
    expect(s.sig_billing).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// SV-9a — Safety-net floor tests. The Pearls Dry Bar bug (composite=26 despite
// client_silent=100 + vol_collapse=100 + flag_performance=true) drove this.
// ---------------------------------------------------------------------------

import { computeSafetyFloor } from "./scoring";
import { SAFETY_FLOOR } from "./config";

describe("computeSafetyFloor — Pearls Dry Bar bug class", () => {
  it("0 triggers → no floor", () => {
    const r = computeSafetyFloor({
      sig_client_silent: 50,
      sig_volume_collapse: 30,
      sig_billing: 20,
      flag_performance: false,
      flag_tickets: false,
    });
    expect(r.floor).toBe(0);
    expect(r.triggers).toEqual([]);
  });

  it("1 trigger (client_silent=80) → YELLOW floor", () => {
    const r = computeSafetyFloor({
      sig_client_silent: 80,
      sig_volume_collapse: 30,
      sig_billing: 20,
      flag_performance: false,
      flag_tickets: false,
    });
    expect(r.floor).toBe(SAFETY_FLOOR.FLOOR_YELLOW);
    expect(r.triggers).toEqual(["client_silent"]);
  });

  it("Pearls Dry Bar (client_silent=100 + vol_collapse=100 + flag_perf) → RED floor", () => {
    const r = computeSafetyFloor({
      sig_client_silent: 100,
      sig_volume_collapse: 100,
      sig_billing: 0,
      flag_performance: true,
      flag_tickets: false,
    });
    expect(r.floor).toBe(SAFETY_FLOOR.FLOOR_RED);
    expect(r.triggers).toContain("client_silent");
    expect(r.triggers).toContain("vol_collapse");
    expect(r.triggers).toContain("flag_perf");
  });

  it("ISH Salon and Spa (billing=70 + flag_tickets) → RED floor (sub-score + flag)", () => {
    const r = computeSafetyFloor({
      sig_client_silent: 30,
      sig_volume_collapse: 20,
      sig_billing: 70,
      flag_performance: false,
      flag_tickets: true,
    });
    expect(r.floor).toBe(SAFETY_FLOOR.FLOOR_RED);
    expect(r.triggers).toContain("billing");
    expect(r.triggers).toContain("flag_tickets");
  });

  it("flag_perf + flag_tickets alone (no sub-scores) → YELLOW only (WATCH lane preserved)", () => {
    // Pre-SV-9a, the WATCH lane lifts HEALTHY + 2 flags to YELLOW. The safety
    // floor must NOT escalate this to RED — that's a different signal class
    // (modifier-flag concern, not catastrophic sub-score firing).
    const r = computeSafetyFloor({
      sig_client_silent: 30,
      sig_volume_collapse: 20,
      sig_billing: 20,
      flag_performance: true,
      flag_tickets: true,
    });
    expect(r.floor).toBe(SAFETY_FLOOR.FLOOR_YELLOW);
    expect(r.triggers).toContain("flag_perf");
    expect(r.triggers).toContain("flag_tickets");
  });

  it("noisy sub-scores (we_silent / response_drop / usage) do NOT trigger floor", () => {
    // Hair Inc class — silent customer, no real activity to drop from. The
    // engine's sig_response_drop / sig_we_silent / sig_usage can spike as
    // noise. Safety floor must ignore those to avoid over-promoting healthy
    // long-tail customers. Only client_silent counts here.
    const r = computeSafetyFloor({
      sig_client_silent: 90,
      sig_volume_collapse: 30, // below threshold
      sig_billing: 0,
      flag_performance: false,
      flag_tickets: false,
    });
    // Only 1 trigger (client_silent), so YELLOW floor, not RED.
    expect(r.floor).toBe(SAFETY_FLOOR.FLOOR_YELLOW);
    expect(r.triggers).toEqual(["client_silent"]);
  });

  it("threshold boundaries: client_silent=79 does NOT trigger; 80 does", () => {
    const justUnder = computeSafetyFloor({
      sig_client_silent: 79,
      sig_volume_collapse: 30,
      sig_billing: 20,
      flag_performance: false,
      flag_tickets: false,
    });
    expect(justUnder.floor).toBe(0);

    const atThreshold = computeSafetyFloor({
      sig_client_silent: 80,
      sig_volume_collapse: 30,
      sig_billing: 20,
      flag_performance: false,
      flag_tickets: false,
    });
    expect(atThreshold.floor).toBe(SAFETY_FLOOR.FLOOR_YELLOW);
  });
});

describe("composeHybridSignals — safety floor wires into composite", () => {
  it("Pearls Dry Bar pattern lifts composite from <30 to >=80 RED", () => {
    const stub = commsSignalsStub({
      sig_we_silent: 0,
      sig_client_silent: 100,
      sig_response_drop: 0,
      sig_volume_collapse: 100,
    });
    const perfStub = {
      flag: true,
      flag_reason: "test",
      profile_clicks_drop_pct: -91,
    } as unknown as Parameters<typeof composeHybridSignals>[0]["performance"];

    const s = composeHybridSignals({
      commsSignals: stub,
      usageScore: 0,
      billingScore: 0,
      performance: perfStub,
      tickets: null,
      commsMetrics: cleanCommsMetrics(),
      mixpanelHasData: true,
      preLaunch: false,
    });
    // Without the safety floor, the weighted sum is 0.15*100 + 0.08*100 = 23.
    // With the safety floor (3 triggers → FLOOR_RED=80), composite must be >= 80.
    expect(s.composite).toBeGreaterThanOrEqual(SAFETY_FLOOR.FLOOR_RED);
    expect(s.tier).toBe("HIGH");
    expect(s.stoplight).toBe("RED");
    expect(s.notes).toMatch(/safety_floor:/);
  });

  it("healthy customer (0 triggers) is NOT promoted by safety net", () => {
    const stub = commsSignalsStub({
      sig_we_silent: 20,
      sig_client_silent: 30,
      sig_response_drop: 10,
      sig_volume_collapse: 20,
    });
    const s = composeHybridSignals({
      commsSignals: stub,
      usageScore: 20,
      billingScore: 10,
      performance: null,
      tickets: null,
      commsMetrics: cleanCommsMetrics(),
      mixpanelHasData: true,
      preLaunch: false,
    });
    // No triggers fire → no floor lift → composite stays low → tier GREEN.
    expect(s.stoplight).toBe("GREEN");
    expect(s.notes).not.toMatch(/safety_floor:/);
  });
});
