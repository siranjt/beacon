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

/**
 * Wave 2c.4 (v3) — promoted heavy "other" subcategories into structured slots.
 * Pins the 8 new named fields so accidental removals fail loudly in CI.
 */
describe("FIELD_CATALOG — Wave 2c.4 (v3) promoted fields", () => {
  it("adds ae_commitment to identity/sold_by", () => {
    expect(FIELD_CATALOG.sold_by.named_fields).toContain("ae_commitment");
    expect(isNamedField("sold_by", "ae_commitment")).toBe(true);
  });

  it("adds migration_history to operational/integration", () => {
    expect(FIELD_CATALOG.integration.named_fields).toContain("migration_history");
    expect(isNamedField("integration", "migration_history")).toBe(true);
  });

  it("adds risk_category and mitigated_at to concerns/latent_risk", () => {
    expect(FIELD_CATALOG.latent_risk.named_fields).toContain("risk_category");
    expect(FIELD_CATALOG.latent_risk.named_fields).toContain("mitigated_at");
    expect(isNamedField("latent_risk", "risk_category")).toBe(true);
    expect(isNamedField("latent_risk", "mitigated_at")).toBe(true);
  });

  it("adds service_specialty to identity/business_profile", () => {
    expect(FIELD_CATALOG.business_profile.named_fields).toContain(
      "service_specialty",
    );
    expect(isNamedField("business_profile", "service_specialty")).toBe(true);
  });

  it("adds pricing_tier to operational/contract", () => {
    expect(FIELD_CATALOG.contract.named_fields).toContain("pricing_tier");
    expect(isNamedField("contract", "pricing_tier")).toBe(true);
  });

  it("adds slow_months to behavioral/seasonal", () => {
    expect(FIELD_CATALOG.seasonal.named_fields).toContain("slow_months");
    expect(isNamedField("seasonal", "slow_months")).toBe(true);
  });

  it("adds prior_am to identity/assignment", () => {
    expect(FIELD_CATALOG.assignment.named_fields).toContain("prior_am");
    expect(isNamedField("assignment", "prior_am")).toBe(true);
  });

  it("keeps the new fields routed under the right category", () => {
    expect(categoryForSubcategory("sold_by")).toBe("identity");
    expect(categoryForSubcategory("integration")).toBe("operational");
    expect(categoryForSubcategory("latent_risk")).toBe("concerns");
    expect(categoryForSubcategory("business_profile")).toBe("identity");
    expect(categoryForSubcategory("contract")).toBe("operational");
    expect(categoryForSubcategory("seasonal")).toBe("behavioral");
    expect(categoryForSubcategory("assignment")).toBe("identity");
  });

  it("keeps v3 categorical fields OUT of NUMERIC_FIELDS", () => {
    // ae_commitment, migration_history, risk_category, service_specialty,
    // pricing_tier, slow_months, prior_am are all free-form text; mitigated_at
    // is a date string. None should land in NUMERIC_FIELDS.
    expect(NUMERIC_FIELDS.has("ae_commitment")).toBe(false);
    expect(NUMERIC_FIELDS.has("migration_history")).toBe(false);
    expect(NUMERIC_FIELDS.has("risk_category")).toBe(false);
    expect(NUMERIC_FIELDS.has("mitigated_at")).toBe(false);
    expect(NUMERIC_FIELDS.has("service_specialty")).toBe(false);
    expect(NUMERIC_FIELDS.has("pricing_tier")).toBe(false);
    expect(NUMERIC_FIELDS.has("slow_months")).toBe(false);
    expect(NUMERIC_FIELDS.has("prior_am")).toBe(false);
  });
});
