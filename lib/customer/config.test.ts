/**
 * Phase E-15.5 — config helper tests.
 *
 * tierToStoplight is the single function that turns a 4-tier internal
 * classification into the 3-color stoplight that AMs actually see. Two
 * subtle behaviors live here: the WATCH lane (HEALTHY/LOW with 2+ modifier
 * flags surfaces as YELLOW) and the billing-crisis override (high
 * billingScore lifts to YELLOW regardless of tier). Both are easy to
 * regress and silently mis-classify customers.
 *
 * Other small helpers: normalizeHealthTier, getRoleForEmail (allowlists).
 */

import { describe, it, expect } from "vitest";
import { tierToStoplight } from "./config";

describe("tierToStoplight — base mapping", () => {
  it("HIGH always → RED, regardless of flags or billing", () => {
    expect(tierToStoplight("HIGH", 0, 0)).toBe("RED");
    expect(tierToStoplight("HIGH", 3, 90)).toBe("RED");
  });

  it("MEDIUM always → YELLOW, regardless of flags or billing", () => {
    expect(tierToStoplight("MEDIUM", 0, 0)).toBe("YELLOW");
    expect(tierToStoplight("MEDIUM", 3, 90)).toBe("YELLOW");
  });

  it("LOW with no flags + low billing → GREEN", () => {
    expect(tierToStoplight("LOW", 0, 0)).toBe("GREEN");
    expect(tierToStoplight("LOW", 1, 0)).toBe("GREEN");
  });

  it("HEALTHY with no flags + low billing → GREEN", () => {
    expect(tierToStoplight("HEALTHY", 0, 0)).toBe("GREEN");
    expect(tierToStoplight("HEALTHY", 1, 0)).toBe("GREEN");
  });
});

describe("tierToStoplight — billing crisis override", () => {
  // The billing override is documented to lift to at least YELLOW when
  // billingScore crosses BILLING_YELLOW_OVERRIDE (configured value).
  // Strong billing signals shouldn't be masked by otherwise-healthy tiers.

  it("HEALTHY + strong billing score (≥ override) → YELLOW", () => {
    // 90 is well above any reasonable override threshold.
    expect(tierToStoplight("HEALTHY", 0, 90)).toBe("YELLOW");
  });

  it("LOW + strong billing → YELLOW (same override path)", () => {
    expect(tierToStoplight("LOW", 0, 90)).toBe("YELLOW");
  });
});

describe("tierToStoplight — WATCH lane (2+ flags lifts HEALTHY/LOW)", () => {
  it("HEALTHY with 2 flags → YELLOW via WATCH lane", () => {
    expect(tierToStoplight("HEALTHY", 2, 0)).toBe("YELLOW");
  });

  it("LOW with 2 flags → YELLOW via WATCH lane", () => {
    expect(tierToStoplight("LOW", 2, 0)).toBe("YELLOW");
  });

  it("HEALTHY with 3 flags → YELLOW (any count >= 2 triggers)", () => {
    expect(tierToStoplight("HEALTHY", 3, 0)).toBe("YELLOW");
  });

  it("HEALTHY with 1 flag → GREEN (below the WATCH threshold)", () => {
    expect(tierToStoplight("HEALTHY", 1, 0)).toBe("GREEN");
  });
});

describe("tierToStoplight — billing default param", () => {
  it("billingScore defaults to 0 (called from older code without that arg)", () => {
    // Older call sites pass two args. TypeScript accepts this since the
    // billing param has a default of 0; verify behavior matches.
    expect(tierToStoplight("HEALTHY", 0)).toBe("GREEN");
  });
});

describe("tierToStoplight — return type contract", () => {
  it("always returns 'RED' | 'YELLOW' | 'GREEN'", () => {
    const valid = new Set(["RED", "YELLOW", "GREEN"]);
    const inputs: Array<[Parameters<typeof tierToStoplight>[0], number, number]> = [
      ["HIGH", 0, 0],
      ["MEDIUM", 0, 0],
      ["LOW", 0, 0],
      ["HEALTHY", 0, 0],
      ["HEALTHY", 5, 100],
      ["LOW", 2, 0],
    ];
    for (const args of inputs) {
      expect(valid.has(tierToStoplight(...args))).toBe(true);
    }
  });
});
