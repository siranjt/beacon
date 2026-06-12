/**
 * WAVE-A-1 — Memory Score (Keeper coverage %) per customer.
 *
 * One per-customer number that tells an AM how complete Keeper's coverage of
 * a customer is. Mirrors the customer-facing Brain pitch: high coverage = a
 * brain that answers everything; low coverage = a to-do list of facts to
 * teach Keeper next.
 *
 * Scoring (v1, weighted by category):
 *   - Walk every (topic_subcategory, field_name) slot in FIELD_CATALOG.
 *   - For each slot, check whether an authoritative fact exists for this
 *     customer — authoritative = NOT soft-deleted, NOT superseded, NOT
 *     stale, NOT past sunset_at. We rely on getFactsForCustomer's default
 *     filter chain (superseded_by IS NULL AND is_stale = false AND
 *     soft_deleted_at IS NULL) — see lib/brain/repo.ts.
 *   - Each named slot contributes its category weight to both the
 *     numerator (when filled) and the denominator (always).
 *   - Score = (sum filled weights) / (sum total weights) * 100, rounded.
 *
 * Why category weights:
 *   The product hypothesis is that operational + identity facts (who they
 *   are, what they pay, what platform they're on) drive most of the
 *   "answers everything" feel for AMs and Beam. Behavioral, concerns, and
 *   relationship facts are valuable but secondary. Weights are exposed at
 *   the top of the file so we can tune them as the surface evolves.
 *
 * 'other' is intentionally NOT counted — it's unbounded by design and
 * would make 100% unreachable. Only the named-fields catalog determines
 * the denominator. Derived assignment fields (current_am, current_pod,
 * etc.) are also out of scope: they aren't stored in beacon_brain_facts.
 *
 * Returns an integer percent plus per-category breakdown so the chip can
 * tooltip ("operational 92%, identity 100%, behavioral 30%...") later.
 *
 * Pure computation — no LLM, no network, no Voyage. Soft-fails: a customer
 * with zero facts returns percent=0, not an error.
 */

import { getFactsForCustomer } from "./repo";
import { FIELD_CATALOG } from "./types";
import type { BrainFact, TopicCategory, TopicSubcategory } from "./types";
import { getCachedContext, makeCacheKey } from "../ai/context-cache";

/**
 * Per-category weight. Operational + identity weighted highest because they
 * drive the "Keeper answers everything" feel. Tune over time if a category
 * starts dominating the chart in unhelpful ways.
 */
export const CATEGORY_WEIGHTS: Record<TopicCategory, number> = {
  operational: 1.5,
  identity: 1.4,
  behavioral: 1.0,
  concerns: 1.0,
  relationship: 0.8,
};

export interface CoverageScore {
  /** Integer 0-100. */
  percent: number;
  /** Count of catalog slots with at least one authoritative fact. */
  slotsFilled: number;
  /** Total count of catalog slots (sum across all subcategories). */
  slotsTotal: number;
  /** Per-category percent (integer 0-100). Categories with zero total slots return 0. */
  perCategory: Record<TopicCategory, number>;
}

/** Cache key prefix — invalidated by any Keeper write path that lands a new fact. */
const COVERAGE_CACHE_PREFIX = "keeper-coverage";

/** 5-minute TTL — matches the default Beam context cache window. */
const TTL_MS = 5 * 60 * 1000;

/**
 * Compute the catalog slot inventory once. The catalog is module-frozen so
 * this is safe to memoize at module init — saves a per-call walk.
 *
 * Each slot is (subcategory, field_name, category). The Set keying we use
 * below indexes by `${subcategory}::${field_name}` so the lookup is O(1)
 * per fact.
 */
type Slot = {
  subcategory: TopicSubcategory;
  field: string;
  category: TopicCategory;
};

function buildCatalogSlots(): Slot[] {
  const slots: Slot[] = [];
  for (const [sub, def] of Object.entries(FIELD_CATALOG) as Array<
    [TopicSubcategory, (typeof FIELD_CATALOG)[TopicSubcategory]]
  >) {
    for (const field of def.named_fields) {
      slots.push({
        subcategory: sub,
        field,
        category: def.category,
      });
    }
  }
  return slots;
}

const CATALOG_SLOTS: Slot[] = buildCatalogSlots();

/**
 * Pure scoring function — given a list of authoritative facts, compute the
 * coverage breakdown. Split from `computeCoverage` so tests can drive it
 * directly without going through the DB-backed reader.
 */
export function scoreCoverageFromFacts(facts: BrainFact[]): CoverageScore {
  // Index facts by `subcategory::field_name` for O(1) presence lookup.
  // Multiple facts at the same slot (e.g. an upsert history) still register
  // as one filled slot — what we measure is presence, not depth.
  const filledKeys = new Set<string>();
  for (const f of facts) {
    // Only count facts that map to a named catalog slot. 'other' rows and
    // any drift (e.g. legacy field_names no longer in the catalog) are
    // ignored — they don't move the denominator either, so the % stays
    // honest.
    const def = FIELD_CATALOG[f.topic_subcategory];
    if (!def) continue;
    if (!def.named_fields.includes(f.field_name)) continue;
    filledKeys.add(`${f.topic_subcategory}::${f.field_name}`);
  }

  // Tally weighted numerator / denominator overall AND per category.
  let totalWeight = 0;
  let filledWeight = 0;
  const perCatTotal: Record<TopicCategory, number> = {
    identity: 0,
    operational: 0,
    behavioral: 0,
    concerns: 0,
    relationship: 0,
  };
  const perCatFilled: Record<TopicCategory, number> = {
    identity: 0,
    operational: 0,
    behavioral: 0,
    concerns: 0,
    relationship: 0,
  };

  let slotsFilled = 0;
  for (const slot of CATALOG_SLOTS) {
    const w = CATEGORY_WEIGHTS[slot.category];
    totalWeight += w;
    perCatTotal[slot.category] += w;
    const key = `${slot.subcategory}::${slot.field}`;
    if (filledKeys.has(key)) {
      filledWeight += w;
      perCatFilled[slot.category] += w;
      slotsFilled += 1;
    }
  }

  const percent =
    totalWeight === 0 ? 0 : Math.round((filledWeight / totalWeight) * 100);
  const perCategory: Record<TopicCategory, number> = {
    identity: perCatTotal.identity
      ? Math.round((perCatFilled.identity / perCatTotal.identity) * 100)
      : 0,
    operational: perCatTotal.operational
      ? Math.round((perCatFilled.operational / perCatTotal.operational) * 100)
      : 0,
    behavioral: perCatTotal.behavioral
      ? Math.round((perCatFilled.behavioral / perCatTotal.behavioral) * 100)
      : 0,
    concerns: perCatTotal.concerns
      ? Math.round((perCatFilled.concerns / perCatTotal.concerns) * 100)
      : 0,
    relationship: perCatTotal.relationship
      ? Math.round((perCatFilled.relationship / perCatTotal.relationship) * 100)
      : 0,
  };

  return {
    percent,
    slotsFilled,
    slotsTotal: CATALOG_SLOTS.length,
    perCategory,
  };
}

/**
 * Read authoritative facts for a customer and score Keeper coverage.
 *
 * Memoized behind the shared context cache (5min TTL, keyed on customer_id).
 * Cache misses fall through to getFactsForCustomer — which honors the
 * default authoritative filter (NOT soft-deleted, NOT superseded, NOT
 * stale, not past sunset_at). We do NOT require confidence_state =
 * 'confirmed' here: candidates count as "Keeper knows something" for
 * coverage purposes. (If product wants to gate on confirmed only, flip
 * confirmedOnly: true below — but that hides Haiku candidates that AMs
 * haven't triaged yet, which understates the score.)
 *
 * Soft-fails: any error in the read path collapses to a zero-coverage
 * result. Coverage is observability, not correctness — a thrown error
 * here would block the panel from rendering.
 */
export async function computeCoverage(
  customer_id: string,
  opts: { bypassCache?: boolean } = {},
): Promise<CoverageScore> {
  if (!customer_id) {
    return scoreCoverageFromFacts([]);
  }
  const key = makeCacheKey(COVERAGE_CACHE_PREFIX, { customer_id });
  return getCachedContext(
    key,
    async () => {
      try {
        const facts = await getFactsForCustomer(customer_id, {
          // Include candidates — they represent something Keeper has heard
          // about and shouldn't be treated as missing.
          confirmedOnly: false,
        });
        return scoreCoverageFromFacts(facts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[keeper-coverage] computeCoverage soft-fail for ${customer_id}: ${msg}`,
        );
        return scoreCoverageFromFacts([]);
      }
    },
    { ttlMs: TTL_MS, bypassCache: opts.bypassCache },
  );
}

/**
 * Map a coverage percent to a KeeperChip confidence tier. Used by both the
 * API route consumer and the V2BrainPanel header.
 *
 *   >= 80%  → "high"     (brass — Keeper has nearly everything)
 *   50–79%  → "moderate" (ember — Keeper has the core, missing some)
 *   <  50%  → "low"      (patina — Keeper has scraps; teach it more)
 */
export function coverageConfidence(
  percent: number,
): "high" | "moderate" | "low" {
  if (percent >= 80) return "high";
  if (percent >= 50) return "moderate";
  return "low";
}
