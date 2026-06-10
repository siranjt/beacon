/**
 * Keeper taxonomy — type/catalog sanity tests.
 *
 * Wave 1.2 expanded the behavioral category with two new subcategories
 * (cadence + sentiment) and added rebook_window_weeks as a numeric-shaped
 * field. These tests pin the taxonomy shape so accidental removals /
 * mis-routings (e.g. dropping a subcategory from FIELD_CATALOG or moving
 * cadence under a different parent category) fail loudly in CI rather
 * than surfacing as runtime "topic_category mismatch" errors from
 * writeBrainFact.
 */

import { describe, it, expect } from "vitest";
import {
  FIELD_CATALOG,
  NUMERIC_FIELDS,
  categoryForSubcategory,
  isNamedField,
} from "./types";

describe("FIELD_CATALOG — Wave 1.2 additions", () => {
  it("includes a cadence subcategory under behavioral", () => {
    expect(FIELD_CATALOG.cadence).toBeDefined();
    expect(FIELD_CATALOG.cadence.category).toBe("behavioral");
  });

  it("includes a sentiment subcategory under behavioral", () => {
    expect(FIELD_CATALOG.sentiment).toBeDefined();
    expect(FIELD_CATALOG.sentiment.category).toBe("behavioral");
  });

  it("declares the expected cadence named fields", () => {
    expect(FIELD_CATALOG.cadence.named_fields).toEqual([
      "rebook_window_weeks",
      "last_rebook_at",
    ]);
  });

  it("declares the expected sentiment named fields", () => {
    expect(FIELD_CATALOG.sentiment.named_fields).toEqual([
      "nps_equivalent_signal",
      "last_signal_at",
      "signal_substance",
    ]);
  });

  it("keeps preferred_channel under behavioral/comms_preference", () => {
    expect(FIELD_CATALOG.comms_preference.category).toBe("behavioral");
    expect(FIELD_CATALOG.comms_preference.named_fields).toContain(
      "preferred_channel",
    );
  });
});

describe("categoryForSubcategory — Wave 1.2 routing", () => {
  it("routes cadence to behavioral", () => {
    expect(categoryForSubcategory("cadence")).toBe("behavioral");
  });

  it("routes sentiment to behavioral", () => {
    expect(categoryForSubcategory("sentiment")).toBe("behavioral");
  });
});

describe("NUMERIC_FIELDS — Wave 1.2", () => {
  it("includes rebook_window_weeks", () => {
    expect(NUMERIC_FIELDS.has("rebook_window_weeks")).toBe(true);
  });

  it("still includes the prior numeric fields", () => {
    expect(NUMERIC_FIELDS.has("staff_count")).toBe(true);
    expect(NUMERIC_FIELDS.has("location_count")).toBe(true);
  });

  it("does NOT include date-shaped fields like last_rebook_at", () => {
    expect(NUMERIC_FIELDS.has("last_rebook_at")).toBe(false);
    expect(NUMERIC_FIELDS.has("last_signal_at")).toBe(false);
  });
});

describe("isNamedField — Wave 1.2 named fields are recognized", () => {
  it("recognizes cadence/rebook_window_weeks", () => {
    expect(isNamedField("cadence", "rebook_window_weeks")).toBe(true);
  });

  it("recognizes sentiment/nps_equivalent_signal", () => {
    expect(isNamedField("sentiment", "nps_equivalent_signal")).toBe(true);
  });

  it("rejects an unknown field under cadence", () => {
    expect(isNamedField("cadence", "wrong_field")).toBe(false);
  });

  it("rejects 'other' as a named field (it's the catchall)", () => {
    expect(isNamedField("cadence", "other")).toBe(false);
  });
});
