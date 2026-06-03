/**
 * Tests for the Beacon AI gap parser (Phase F-polish-AI Tier 3).
 *
 * Tests target parseGaps + stripGapMarkers — pure functions, no DB.
 * Coverage:
 *   - Each of the 4 valid categories parses
 *   - Invalid categories are silently dropped
 *   - Em-dash, hyphen, and colon separators all work
 *   - Multiple gaps in one response → multiple results, in order
 *   - Duplicate gaps in one response → collapsed
 *   - Missing description → dropped
 *   - Empty / null input → empty array
 *   - stripGapMarkers removes the markers and normalizes whitespace
 */

import { describe, it, expect } from "vitest";
import { parseGaps, stripGapMarkers } from "./gaps";

describe("parseGaps — happy path", () => {
  it("parses a single data_missing gap with em-dash", () => {
    const text = "Here's what I have. <gap: data_missing — silence by pod at 45-day threshold>";
    const gaps = parseGaps(text);
    expect(gaps).toEqual([
      { category: "data_missing", description: "silence by pod at 45-day threshold" },
    ]);
  });

  it("parses a tool_insufficient gap", () => {
    const text = "Sorry — <gap: tool_insufficient — query_customer_book can't group by city>";
    const gaps = parseGaps(text);
    expect(gaps[0].category).toBe("tool_insufficient");
    expect(gaps[0].description).toBe("query_customer_book can't group by city");
  });

  it("parses an out_of_scope gap", () => {
    const gaps = parseGaps("<gap: out_of_scope — financial forecasting>");
    expect(gaps).toEqual([{ category: "out_of_scope", description: "financial forecasting" }]);
  });

  it("parses an assumption_unclear gap", () => {
    const gaps = parseGaps('<gap: assumption_unclear — "best AM" by what metric?>');
    expect(gaps[0].category).toBe("assumption_unclear");
    expect(gaps[0].description).toBe('"best AM" by what metric?');
  });
});

describe("parseGaps — separator tolerance", () => {
  it("accepts hyphen separator", () => {
    const gaps = parseGaps("<gap: data_missing - silence by pod>");
    expect(gaps[0].description).toBe("silence by pod");
  });

  it("accepts colon separator", () => {
    const gaps = parseGaps("<gap: data_missing: silence by pod>");
    expect(gaps[0].description).toBe("silence by pod");
  });

  it("em-dash is the canonical separator", () => {
    const gaps = parseGaps("<gap: data_missing — silence by pod>");
    expect(gaps[0].description).toBe("silence by pod");
  });
});

describe("parseGaps — multiple gaps in one response", () => {
  it("returns each gap in order", () => {
    const text = `
      Here's my answer.
      <gap: data_missing — MRR histogram>
      <gap: tool_insufficient — query doesn't support week-over-week>
    `;
    const gaps = parseGaps(text);
    expect(gaps.length).toBe(2);
    expect(gaps[0].category).toBe("data_missing");
    expect(gaps[1].category).toBe("tool_insufficient");
  });

  it("collapses duplicate gaps (same category + same description)", () => {
    const text = `
      <gap: data_missing — MRR histogram>
      Something else.
      <gap: data_missing — MRR histogram>
    `;
    const gaps = parseGaps(text);
    expect(gaps.length).toBe(1);
  });

  it("doesn't collapse same description across different categories", () => {
    const text = `
      <gap: data_missing — MRR histogram>
      <gap: tool_insufficient — MRR histogram>
    `;
    const gaps = parseGaps(text);
    expect(gaps.length).toBe(2);
  });
});

describe("parseGaps — invalid input", () => {
  it("empty string returns empty array", () => {
    expect(parseGaps("")).toEqual([]);
  });

  it("text with no markers returns empty array", () => {
    expect(parseGaps("Here are 3 customers at risk. Nothing else to flag.")).toEqual([]);
  });

  it("invalid category is silently dropped", () => {
    const gaps = parseGaps("<gap: madeup_category — should be ignored>");
    expect(gaps).toEqual([]);
  });

  it("missing description is dropped", () => {
    const gaps = parseGaps("<gap: data_missing — >");
    expect(gaps).toEqual([]);
  });

  it("category case-insensitive (normalized to lowercase)", () => {
    const gaps = parseGaps("<gap: DATA_MISSING — silence by pod>");
    expect(gaps[0].category).toBe("data_missing");
  });

  it("ignores malformed brackets", () => {
    // Missing closing bracket
    expect(parseGaps("<gap: data_missing — silence by pod")).toEqual([]);
  });
});

describe("stripGapMarkers", () => {
  it("removes a single marker", () => {
    const text = "Here's what I have. <gap: data_missing — silence by pod>";
    expect(stripGapMarkers(text)).toBe("Here's what I have.");
  });

  it("removes multiple markers", () => {
    const text = `
Answer here.
<gap: data_missing — x>
<gap: tool_insufficient — y>
    `.trim();
    const cleaned = stripGapMarkers(text);
    expect(cleaned).not.toContain("<gap:");
    expect(cleaned).toContain("Answer here.");
  });

  it("leaves text without markers unchanged", () => {
    const text = "Plain answer, no markers.";
    expect(stripGapMarkers(text)).toBe(text);
  });

  it("trims trailing whitespace left behind by stripping", () => {
    const text = "Body.\n\n<gap: data_missing — x>";
    expect(stripGapMarkers(text).endsWith(".")).toBe(true);
  });

  it("empty string passes through", () => {
    expect(stripGapMarkers("")).toBe("");
  });
});
