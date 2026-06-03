import { describe, it, expect } from "vitest";
import { applyOutcomeOverride, type CallOutcomeRow } from "./call-outcomes";
import type { ScoredCustomerV2 } from "./types";

// Minimal builders — call-outcomes only touches signals_v2 + metabase_health.
function makeCustomer(args: {
  entity_id?: string;
  stoplight?: "RED" | "YELLOW" | "GREEN";
  signals_tier?: "HIGH" | "MEDIUM" | "LOW" | "HEALTHY";
  composite?: number;
  health_tier?: string | null;
}): ScoredCustomerV2 & { metabase_health?: { health_tier?: string | null } } {
  return {
    entity_id: args.entity_id ?? "ent-1",
    customer_id: "cust-1",
    am_name: "Test AM",
    company: "Test Co",
    subscription_id: "sub-1",
    cb_status: "active",
    plan_amount: 150,
    activated_at: null,
    ob_date: "",
    auto_collection: "on",
    mrr_basesheet: "",
    zoca_status: "ZOCA",
    churn_potential_flag: "",
    match_source: "customer_id",
    in_chrone: true,
    metrics: {} as ScoredCustomerV2["metrics"],
    signals: {} as ScoredCustomerV2["signals"],
    signals_v2: {
      stoplight: args.stoplight ?? "RED",
      tier: args.signals_tier ?? "HIGH",
      composite: args.composite ?? 70,
      pre_launch: false,
    } as ScoredCustomerV2["signals_v2"],
    pod: "Pod 1",
    usage: null,
    billing: null,
    performance: null,
    tickets: null,
    metabase_health: args.health_tier
      ? ({ health_tier: args.health_tier } as Record<string, string | null>)
      : undefined,
  } as ScoredCustomerV2 & { metabase_health?: { health_tier?: string | null } };
}

function makeOutcome(
  outcome: CallOutcomeRow["outcome"],
  expiresInMs: number = 7 * 24 * 60 * 60 * 1000,
): CallOutcomeRow {
  return {
    entity_id: "ent-1",
    outcome,
    marked_at: new Date().toISOString(),
    marked_by_email: "am@zoca.com",
    marked_by_name: "Test AM",
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

describe("applyOutcomeOverride", () => {
  describe("no outcome / expired outcome", () => {
    it("returns customer untouched when outcome is undefined", () => {
      const c = makeCustomer({ stoplight: "RED", health_tier: "CRITICAL" });
      const result = applyOutcomeOverride(c, undefined);
      expect(result).toBe(c);
      expect(result.call_outcome).toBeUndefined();
    });

    it("returns customer untouched when outcome is expired", () => {
      const c = makeCustomer({ stoplight: "RED", health_tier: "CRITICAL" });
      const expired = makeOutcome("connected", -1000); // 1s in past
      const result = applyOutcomeOverride(c, expired);
      expect(result).toBe(c);
      expect(result.call_outcome).toBeUndefined();
      // Tier untouched
      expect(result.signals_v2.stoplight).toBe("RED");
    });

    it("returns customer untouched when expires_at is malformed", () => {
      const c = makeCustomer({ stoplight: "RED" });
      const bad: CallOutcomeRow = {
        ...makeOutcome("connected"),
        expires_at: "not-a-date",
      };
      const result = applyOutcomeOverride(c, bad);
      expect(result).toBe(c);
    });
  });

  describe("non-connected outcomes (vm, not_connected)", () => {
    it("vm decorates call_outcome but does NOT change tier", () => {
      const c = makeCustomer({ stoplight: "RED", signals_tier: "HIGH", health_tier: "AT-RISK" });
      const result = applyOutcomeOverride(c, makeOutcome("vm"));
      expect(result.call_outcome?.outcome).toBe("vm");
      // Tier preserved — VM means customer didn't pick up, still needs follow-up
      expect(result.signals_v2.stoplight).toBe("RED");
      expect(result.signals_v2.tier).toBe("HIGH");
      const mh = (result as ScoredCustomerV2 & {
        metabase_health?: { health_tier?: string };
      }).metabase_health;
      expect(mh?.health_tier).toBe("AT-RISK");
    });

    it("not_connected decorates call_outcome but does NOT change tier", () => {
      const c = makeCustomer({ stoplight: "RED", signals_tier: "HIGH", health_tier: "CRITICAL" });
      const result = applyOutcomeOverride(c, makeOutcome("not_connected"));
      expect(result.call_outcome?.outcome).toBe("not_connected");
      expect(result.signals_v2.stoplight).toBe("RED");
      expect(result.signals_v2.tier).toBe("HIGH");
      const mh = (result as ScoredCustomerV2 & {
        metabase_health?: { health_tier?: string };
      }).metabase_health;
      expect(mh?.health_tier).toBe("CRITICAL");
    });
  });

  describe("connected outcome — tier demotion", () => {
    it("CRITICAL → MONITOR (Watch)", () => {
      const c = makeCustomer({
        stoplight: "RED",
        signals_tier: "HIGH",
        health_tier: "CRITICAL",
      });
      const result = applyOutcomeOverride(c, makeOutcome("connected"));
      const mh = (result as ScoredCustomerV2 & {
        metabase_health?: { health_tier?: string; _raw_health_tier?: string };
      }).metabase_health;
      expect(mh?.health_tier).toBe("MONITOR");
      expect(mh?._raw_health_tier).toBe("CRITICAL");
      expect(result.signals_v2.stoplight).toBe("YELLOW");
      expect(result.signals_v2.tier).toBe("MEDIUM");
    });

    it("CRITICAL - DEAL BREAKER → MONITOR (Watch)", () => {
      const c = makeCustomer({
        stoplight: "RED",
        signals_tier: "HIGH",
        health_tier: "CRITICAL - DEAL BREAKER",
      });
      const result = applyOutcomeOverride(c, makeOutcome("connected"));
      const mh = (result as ScoredCustomerV2 & {
        metabase_health?: { health_tier?: string };
      }).metabase_health;
      expect(mh?.health_tier).toBe("MONITOR");
    });

    it("AT-RISK → MONITOR (Watch)", () => {
      const c = makeCustomer({
        stoplight: "RED",
        signals_tier: "HIGH",
        health_tier: "AT-RISK",
      });
      const result = applyOutcomeOverride(c, makeOutcome("connected"));
      const mh = (result as ScoredCustomerV2 & {
        metabase_health?: { health_tier?: string };
      }).metabase_health;
      expect(mh?.health_tier).toBe("MONITOR");
      expect(result.signals_v2.stoplight).toBe("YELLOW");
    });

    it("MONITOR → HEALTHY (already on Watch, successful call lifts to Healthy)", () => {
      const c = makeCustomer({
        stoplight: "YELLOW",
        signals_tier: "MEDIUM",
        health_tier: "MONITOR",
      });
      const result = applyOutcomeOverride(c, makeOutcome("connected"));
      const mh = (result as ScoredCustomerV2 & {
        metabase_health?: { health_tier?: string };
      }).metabase_health;
      expect(mh?.health_tier).toBe("HEALTHY");
      // YELLOW stoplight stays — only RED gets demoted to YELLOW.
      expect(result.signals_v2.stoplight).toBe("YELLOW");
    });

    it("HEALTHY stays HEALTHY (no demotion needed)", () => {
      const c = makeCustomer({
        stoplight: "GREEN",
        signals_tier: "HEALTHY",
        health_tier: "HEALTHY",
      });
      const result = applyOutcomeOverride(c, makeOutcome("connected"));
      // Pill still renders, tier unchanged
      expect(result.call_outcome?.outcome).toBe("connected");
      const mh = (result as ScoredCustomerV2 & {
        metabase_health?: { health_tier?: string };
      }).metabase_health;
      expect(mh?.health_tier).toBe("HEALTHY");
      expect(result.signals_v2.stoplight).toBe("GREEN");
      expect(result.signals_v2.tier).toBe("HEALTHY");
    });

    it("missing metabase_health defaults to MONITOR (Watch)", () => {
      // No metabase_health row — treat as not-healthy, demote to MONITOR.
      const c = makeCustomer({
        stoplight: "RED",
        signals_tier: "HIGH",
        health_tier: null,
      });
      const result = applyOutcomeOverride(c, makeOutcome("connected"));
      const mh = (result as ScoredCustomerV2 & {
        metabase_health?: { health_tier?: string };
      }).metabase_health;
      expect(mh?.health_tier).toBe("MONITOR");
      expect(result.signals_v2.stoplight).toBe("YELLOW");
    });

    it("override is idempotent — calling twice produces the same result", () => {
      const c = makeCustomer({
        stoplight: "RED",
        signals_tier: "HIGH",
        health_tier: "CRITICAL",
      });
      const once = applyOutcomeOverride(c, makeOutcome("connected"));
      const twice = applyOutcomeOverride(once, makeOutcome("connected"));
      const mhOnce = (once as ScoredCustomerV2 & {
        metabase_health?: { health_tier?: string };
      }).metabase_health;
      const mhTwice = (twice as ScoredCustomerV2 & {
        metabase_health?: { health_tier?: string };
      }).metabase_health;
      expect(mhTwice?.health_tier).toBe(mhOnce?.health_tier);
      expect(twice.signals_v2.stoplight).toBe(once.signals_v2.stoplight);
    });
  });

  describe("call_outcome decoration", () => {
    it("populates marked_by_name and expires_at on the customer", () => {
      const c = makeCustomer({ stoplight: "YELLOW", health_tier: "MONITOR" });
      const out = makeOutcome("vm");
      const result = applyOutcomeOverride(c, out);
      expect(result.call_outcome).toEqual({
        outcome: "vm",
        marked_at: out.marked_at,
        marked_by_email: out.marked_by_email,
        marked_by_name: out.marked_by_name,
        expires_at: out.expires_at,
      });
    });
  });
});
