/**
 * Pure-function tests for lib/ai/spend-log.ts.
 *
 * priceUsd() + pricingFor() + extractUsage() are pure and don't touch the
 * DB / network — those run here. logSpend() itself is fire-and-forget and
 * gated on POSTGRES_URL, so we don't cover the insert path in vitest;
 * the migration + a manual smoke test verify that end-to-end.
 */

import { describe, it, expect } from "vitest";
import {
  pricingFor,
  priceUsd,
  extractUsage,
  ANTHROPIC_PRICING_PER_MTOK,
} from "./spend-log";

describe("pricingFor", () => {
  it("returns Sonnet pricing for sonnet-4-6", () => {
    expect(pricingFor("claude-sonnet-4-6")).toEqual({ input: 3.0, output: 15.0 });
  });

  it("returns Haiku pricing for haiku-4-5", () => {
    expect(pricingFor("claude-haiku-4-5-20251001")).toEqual({
      input: 1.0,
      output: 5.0,
    });
  });

  it("returns Opus pricing for opus-4-6", () => {
    expect(pricingFor("claude-opus-4-6")).toEqual({ input: 15.0, output: 75.0 });
  });

  it("falls back to Sonnet rate for unknown models (conservative over-estimate)", () => {
    expect(pricingFor("claude-mystery-9000")).toEqual({
      input: 3.0,
      output: 15.0,
    });
  });
});

describe("priceUsd", () => {
  it("computes Haiku cost — input + output only", () => {
    // 100K input + 50K output on Haiku 4.5:
    //   100K * $1/MTok = $0.10
    //    50K * $5/MTok = $0.25
    //   total $0.35
    const cost = priceUsd({
      model: "claude-haiku-4-5-20251001",
      input_tokens: 100_000,
      output_tokens: 50_000,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
    expect(cost).toBeCloseTo(0.35, 4);
  });

  it("applies the cache-read 0.1x multiplier", () => {
    // 100K cache_read on Sonnet at $3/MTok input rate * 0.1 = $0.03
    const cost = priceUsd({
      model: "claude-sonnet-4-6",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 100_000,
      cache_creation_tokens: 0,
    });
    expect(cost).toBeCloseTo(0.03, 4);
  });

  it("applies the cache-write 1.25x multiplier", () => {
    // 100K cache_creation on Sonnet at $3/MTok * 1.25 = $0.375
    const cost = priceUsd({
      model: "claude-sonnet-4-6",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 100_000,
    });
    expect(cost).toBeCloseTo(0.375, 4);
  });

  it("sums all four buckets correctly on Sonnet", () => {
    // 10K input + 5K output + 20K cache_read + 30K cache_write
    //   input:   10K * 3/1e6              = 0.03
    //   output:   5K * 15/1e6              = 0.075
    //   c_read:  20K * 3/1e6 * 0.1        = 0.006
    //   c_write: 30K * 3/1e6 * 1.25       = 0.1125
    //   total                              = 0.2235
    const cost = priceUsd({
      model: "claude-sonnet-4-6",
      input_tokens: 10_000,
      output_tokens: 5_000,
      cache_read_tokens: 20_000,
      cache_creation_tokens: 30_000,
    });
    expect(cost).toBeCloseTo(0.2235, 4);
  });

  it("returns 0 on all-zero usage", () => {
    expect(
      priceUsd({
        model: "claude-sonnet-4-6",
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      }),
    ).toBe(0);
  });
});

describe("extractUsage", () => {
  it("returns zeros for null / undefined / non-object", () => {
    const zeros = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
    expect(extractUsage(null)).toEqual(zeros);
    expect(extractUsage(undefined)).toEqual(zeros);
    expect(extractUsage("nope")).toEqual(zeros);
  });

  it("reads input/output/cache token fields off SDK-shaped usage", () => {
    const msg = {
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 400,
      },
    };
    expect(extractUsage(msg)).toEqual({
      input_tokens: 100,
      output_tokens: 200,
      cache_read_tokens: 300,
      cache_creation_tokens: 400,
    });
  });

  it("falls back to 0 for missing fields", () => {
    expect(extractUsage({ usage: { input_tokens: 42 } })).toEqual({
      input_tokens: 42,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });

  it("rejects non-numeric values", () => {
    expect(
      extractUsage({
        usage: { input_tokens: "lots", output_tokens: NaN },
      }),
    ).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });
});

describe("ANTHROPIC_PRICING_PER_MTOK", () => {
  it("covers the three production model families", () => {
    expect(ANTHROPIC_PRICING_PER_MTOK["claude-sonnet-4-6"]).toBeDefined();
    expect(ANTHROPIC_PRICING_PER_MTOK["claude-haiku-4-5-20251001"]).toBeDefined();
    expect(ANTHROPIC_PRICING_PER_MTOK["claude-opus-4-6"]).toBeDefined();
  });
});
