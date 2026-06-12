/**
 * WAVE-A-1 — coverage scoring tests.
 *
 * Three required cases (per the ticket):
 *   1. Empty customer (no facts) → percent=0
 *   2. Fully-filled customer (every catalog slot has an authoritative fact)
 *      → percent=100
 *   3. Half-filled customer where operational facts dominate → score
 *      reflects the operational weight (>50% even when raw slot count is
 *      exactly half)
 *
 * Drives the pure `scoreCoverageFromFacts` so we don't need a postgres
 * stub. The DB path (`computeCoverage`) just wraps it behind the context
 * cache + getFactsForCustomer reader.
 */

import { describe, it, expect } from "vitest";
import { scoreCoverageFromFacts, CATEGORY_WEIGHTS } from "./coverage";
import {
  FIELD_CATALOG,
  type BrainFact,
  type TopicCategory,
  type TopicSubcategory,
} from "./types";

// ---------- fixtures ----------

/** Minimal authoritative-shaped fact. Only the fields the scorer reads. */
function fact(
  subcategory: TopicSubcategory,
  field_name: string,
): BrainFact {
  const category = FIELD_CATALOG[subcategory].category;
  return {
    fact_id: `${subcategory}-${field_name}-id`,
    customer_id: "c1",
    topic_category: category,
    topic_subcategory: subcategory,
    field_name,
    value: "v",
    confidence_state: "confirmed",
    source_type: "manual",
    source_ref: null,
    owning_am_email: null,
    confirmed_by_email: null,
    confirmed_at: null,
    sunset_at: null,
    current_version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    soft_deleted_at: null,
    value_numeric: null,
    citation_count: 0,
    last_cited_at: null,
  } as BrainFact;
}

/** Walk the catalog and synthesize a fact for every named slot. */
function everySlot(): BrainFact[] {
  const facts: BrainFact[] = [];
  for (const [sub, def] of Object.entries(FIELD_CATALOG) as Array<
    [TopicSubcategory, (typeof FIELD_CATALOG)[TopicSubcategory]]
  >) {
    for (const field of def.named_fields) {
      facts.push(fact(sub, field));
    }
  }
  return facts;
}

/** Synthesize facts for one category only. */
function slotsForCategory(cat: TopicCategory): BrainFact[] {
  const facts: BrainFact[] = [];
  for (const [sub, def] of Object.entries(FIELD_CATALOG) as Array<
    [TopicSubcategory, (typeof FIELD_CATALOG)[TopicSubcategory]]
  >) {
    if (def.category !== cat) continue;
    for (const field of def.named_fields) {
      facts.push(fact(sub, field));
    }
  }
  return facts;
}

// ---------- tests ----------

describe("scoreCoverageFromFacts", () => {
  it("returns 0% when the customer has no Keeper facts", () => {
    const score = scoreCoverageFromFacts([]);
    expect(score.percent).toBe(0);
    expect(score.slotsFilled).toBe(0);
    expect(score.slotsTotal).toBeGreaterThan(0);
    expect(score.perCategory.identity).toBe(0);
    expect(score.perCategory.operational).toBe(0);
    expect(score.perCategory.behavioral).toBe(0);
    expect(score.perCategory.concerns).toBe(0);
    expect(score.perCategory.relationship).toBe(0);
  });

  it("returns 100% when every catalog slot has an authoritative fact", () => {
    const score = scoreCoverageFromFacts(everySlot());
    expect(score.percent).toBe(100);
    expect(score.slotsFilled).toBe(score.slotsTotal);
    expect(score.perCategory.identity).toBe(100);
    expect(score.perCategory.operational).toBe(100);
    expect(score.perCategory.behavioral).toBe(100);
    expect(score.perCategory.concerns).toBe(100);
    expect(score.perCategory.relationship).toBe(100);
  });

  it("ignores 'other' rows and unknown field_names — they don't move the score", () => {
    const facts: BrainFact[] = [
      fact("owner_info", "other"), // 'other' not in named_fields
      fact("contract", "this_is_not_a_real_field"),
    ];
    const score = scoreCoverageFromFacts(facts);
    expect(score.percent).toBe(0);
    expect(score.slotsFilled).toBe(0);
  });

  it("reflects category weighting: operational-only fills score above the raw slot ratio", () => {
    // Setup: fill all operational slots and nothing else. Operational is
    // weighted at 1.5; raw slot ratio would be a much smaller share, but
    // the weighted score should be operational_weight / total_weight.
    const opFacts = slotsForCategory("operational");
    const score = scoreCoverageFromFacts(opFacts);

    // Compute the expected weighted % from the catalog + weights so the
    // test reads as "the formula is doing what the docstring says" instead
    // of just hardcoding a number that drifts when the taxonomy expands.
    let totalWeight = 0;
    let opWeight = 0;
    for (const [, def] of Object.entries(FIELD_CATALOG)) {
      const w = CATEGORY_WEIGHTS[def.category];
      const slotCount = def.named_fields.length;
      totalWeight += w * slotCount;
      if (def.category === "operational") {
        opWeight += w * slotCount;
      }
    }
    const expectedPercent = Math.round((opWeight / totalWeight) * 100);

    expect(score.percent).toBe(expectedPercent);
    expect(score.perCategory.operational).toBe(100);
    expect(score.perCategory.identity).toBe(0);
    expect(score.perCategory.behavioral).toBe(0);

    // And the operational-only fill should beat what an "even" coverage of
    // the same slot count would give us — proves the weight is doing work.
    const rawSlotRatio =
      (opFacts.length / score.slotsTotal) * 100;
    expect(score.percent).toBeGreaterThan(Math.round(rawSlotRatio));
  });

  it("half-filled customer with operational+identity weighted more reflects the weight", () => {
    // Fill operational + identity (the two heavy-weighted categories) and
    // leave behavioral / concerns / relationship empty. The slot share is
    // somewhere near half; the weighted % should beat that share because
    // operational + identity carry the two largest weights.
    const facts = [
      ...slotsForCategory("operational"),
      ...slotsForCategory("identity"),
    ];
    const score = scoreCoverageFromFacts(facts);

    // Expected weighted percent — recompute from catalog + weights so the
    // expectation tracks taxonomy changes automatically.
    let totalWeight = 0;
    let filledWeight = 0;
    for (const [, def] of Object.entries(FIELD_CATALOG)) {
      const w = CATEGORY_WEIGHTS[def.category];
      const slotCount = def.named_fields.length;
      totalWeight += w * slotCount;
      if (def.category === "operational" || def.category === "identity") {
        filledWeight += w * slotCount;
      }
    }
    const expectedPercent = Math.round((filledWeight / totalWeight) * 100);

    expect(score.percent).toBe(expectedPercent);
    expect(score.perCategory.operational).toBe(100);
    expect(score.perCategory.identity).toBe(100);
    expect(score.perCategory.behavioral).toBe(0);
    expect(score.perCategory.concerns).toBe(0);
    expect(score.perCategory.relationship).toBe(0);

    // The raw-slot-share read of the same coverage is strictly lower than
    // the weighted percent — proving that operational + identity getting
    // weighted at 1.5 / 1.4 is doing the work the docstring promises.
    const rawSlotShare = (facts.length / score.slotsTotal) * 100;
    expect(score.percent).toBeGreaterThan(Math.round(rawSlotShare));
  });

  it("multiple facts at the same slot count as one filled slot (presence, not depth)", () => {
    const sameSlotTwice = [
      fact("owner_info", "owner_name"),
      fact("owner_info", "owner_name"),
    ];
    const score = scoreCoverageFromFacts(sameSlotTwice);
    // Should be a single filled slot — the second row is a same-tuple
    // upsert in reality, not an additional slot.
    expect(score.slotsFilled).toBe(1);
  });
});
