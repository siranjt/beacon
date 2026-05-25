/**
 * Phase E-15.5 — hubspot-companies pure-helper tests.
 *
 * normalizeName is the join key between HubSpot's free-form company name
 * and Metabase's bizname column. If it normalizes one source differently
 * from the other, every bizname-fallback match silently fails. We mirror
 * Metabase's transform: lowercase → replace non-alphanumerics with space
 * → collapse whitespace → trim.
 */

import { describe, it, expect } from "vitest";
import { normalizeName } from "./hubspot-companies";

describe("normalizeName — case + whitespace", () => {
  it("lowercases", () => {
    expect(normalizeName("Acme Spa")).toBe("acme spa");
  });

  it("collapses runs of whitespace", () => {
    expect(normalizeName("Acme   Spa")).toBe("acme spa");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeName("  Acme Spa  ")).toBe("acme spa");
  });
});

describe("normalizeName — punctuation", () => {
  it("replaces ampersand with space (then collapses)", () => {
    expect(normalizeName("Acme & Co")).toBe("acme co");
  });

  it("replaces periods with space", () => {
    expect(normalizeName("A.B.C.")).toBe("a b c");
  });

  it("replaces apostrophes (curly + straight)", () => {
    expect(normalizeName("Joe's Salon")).toBe("joe s salon");
    expect(normalizeName("Joe’s Salon")).toBe("joe s salon");
  });

  it("replaces hyphens / em-dash", () => {
    expect(normalizeName("Hair-Co")).toBe("hair co");
    expect(normalizeName("Hair—Co")).toBe("hair co");
  });

  it("collapses multiple punctuation runs", () => {
    expect(normalizeName("A!!??B")).toBe("a b");
  });
});

describe("normalizeName — accented characters", () => {
  // The current implementation strips non-ASCII alphanumeric chars entirely.
  // This is a documented behavior — if you change it, update the test.
  it("strips accented vowels (treated as non-[a-z0-9])", () => {
    expect(normalizeName("Café")).toBe("caf");
  });

  it("strips non-Latin scripts entirely", () => {
    expect(normalizeName("日本 Salon")).toBe("salon");
  });
});

describe("normalizeName — defensive inputs", () => {
  it("returns empty string for empty input", () => {
    expect(normalizeName("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeName("   ")).toBe("");
  });

  it("returns empty string for null-coerced input (defensive)", () => {
    // The implementation has `(s || "")` so falsy inputs become empty.
    // We can't type-pass null, but exercising via cast covers the runtime guard.
    expect(normalizeName(null as unknown as string)).toBe("");
    expect(normalizeName(undefined as unknown as string)).toBe("");
  });

  it("returns input that's already normalized unchanged", () => {
    expect(normalizeName("acme spa")).toBe("acme spa");
  });
});

describe("normalizeName — round-trip stability", () => {
  it("normalizing twice is the same as normalizing once (idempotent)", () => {
    const once = normalizeName("Acme & Co., LLC!");
    const twice = normalizeName(once);
    expect(twice).toBe(once);
  });

  it("real-world examples", () => {
    expect(normalizeName("The Skin Boutique")).toBe("the skin boutique");
    expect(normalizeName("Eyeline Threading & Spa, LLC.")).toBe(
      "eyeline threading spa llc",
    );
    expect(normalizeName("Lash Bar (Park Slope)")).toBe("lash bar park slope");
  });
});
