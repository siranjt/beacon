/**
 * Beacon Brain — retrieval layer for Beacon AI prompt building.
 *
 * Reads confirmed, non-sunset facts for a customer and renders a
 * compact, topic-clustered block ready to inject into the prompt's
 * CONTEXT JSON. The block is designed for the model to:
 *   1. Quote specific values when answering.
 *   2. Cite the fact_id via [brain:FACT_ID] markers (parallel to the
 *      existing [cite:KEY] pattern for snapshot facts).
 *
 * Wave 2a (this file): simple "all confirmed facts, topic-clustered,
 * hard-cap at MAX_FACTS" retrieval. Predictable, no embeddings,
 * always-includes Identity + Operational on principle (those are
 * always load-bearing).
 *
 * Wave 2b (deferred): embedding-based relevance ranking over the
 * Behavioral + Concerns + 'other' tail, with the Identity/Operational
 * floor still in place.
 */

import { getFactsForCustomer } from "./repo";
import type {
  BrainFact,
  TopicCategory,
  TopicSubcategory,
} from "./types";

/**
 * Hard cap on facts injected into a single prompt. Customer-360 has
 * room (snapshot blob is ~5KB, this adds ~3KB at max). If a customer
 * has more than this, the trim strategy keeps Identity + Operational
 * fully (they're always relevant) and drops oldest-confirmed Behavioral
 * / Concerns / 'other' rows first.
 */
const MAX_FACTS_PER_CUSTOMER = 40;

/**
 * Floor categories — always included in retrieval regardless of cap.
 * Identity (owner, sold-by) and Operational (contract, integration)
 * are load-bearing for nearly any question. The cap eats into
 * Behavioral + Concerns + 'other' tail first.
 */
const FLOOR_CATEGORIES: ReadonlySet<TopicCategory> = new Set([
  "identity",
  "operational",
]);

/**
 * Shape returned to the context loader. Two fields:
 *   - prompt_block: the JSON-stringifiable structure to inject into
 *     CONTEXT under a `brain` key. Topic-clustered for legibility.
 *   - fact_ids_for_citation: flat map of fact_id → {topic, value} so
 *     downstream citation logic (parallel to citation_lookup) can
 *     resolve [brain:fact_id] markers in the model's reply.
 */
export interface BrainPromptInjection {
  prompt_block: {
    identity: Record<string, string>;
    operational: Record<string, string>;
    behavioral: Record<string, string>;
    concerns: Record<string, string>;
    other: Array<{ subcategory: TopicSubcategory; value: string }>;
    facts_returned: number;
    facts_dropped: number;
  };
  fact_ids_for_citation: Record<
    string,
    { topic: TopicCategory; subcategory: TopicSubcategory; field: string; value: string }
  >;
}

/**
 * Build the Brain block for a customer's prompt. Returns null when no
 * customer_id is available OR the customer has zero confirmed facts —
 * lets the caller skip injecting an empty `brain: {}` block.
 *
 * Trim strategy when over cap:
 *   1. Always include Identity + Operational facts (floor).
 *   2. Sort remaining (Behavioral + Concerns + 'other') by confirmed_at
 *      DESC (newest first).
 *   3. Take from the top until (floor_count + extra) = MAX_FACTS.
 *
 * 'other' rows render as a list (subcategory + value) since they
 * don't have a stable field_name to dictionary-key on.
 */
export async function loadBrainForPrompt(
  customer_id: string | null | undefined,
): Promise<BrainPromptInjection | null> {
  if (!customer_id) return null;

  const facts = await getFactsForCustomer(customer_id, { confirmedOnly: true });
  if (facts.length === 0) return null;

  // Split into floor + tail.
  const floor = facts.filter((f) => FLOOR_CATEGORIES.has(f.topic_category));
  const tail = facts.filter((f) => !FLOOR_CATEGORIES.has(f.topic_category));

  // If under cap, include everything. Otherwise trim the tail.
  const capForTail = Math.max(0, MAX_FACTS_PER_CUSTOMER - floor.length);
  const tailSorted = tail
    .slice()
    .sort((a, b) => {
      // confirmed_at DESC; null falls to the bottom (shouldn't happen for
      // confirmed rows but defensive).
      const at = a.confirmed_at ?? a.updated_at;
      const bt = b.confirmed_at ?? b.updated_at;
      return bt.localeCompare(at);
    });
  const tailKept = tailSorted.slice(0, capForTail);
  const dropped = tailSorted.length - tailKept.length;

  const kept = [...floor, ...tailKept];

  // Build the topic-clustered prompt block.
  const identity: Record<string, string> = {};
  const operational: Record<string, string> = {};
  const behavioral: Record<string, string> = {};
  const concerns: Record<string, string> = {};
  const other: Array<{ subcategory: TopicSubcategory; value: string }> = [];

  const fact_ids_for_citation: BrainPromptInjection["fact_ids_for_citation"] = {};

  for (const f of kept) {
    fact_ids_for_citation[f.fact_id] = {
      topic: f.topic_category,
      subcategory: f.topic_subcategory,
      field: f.field_name,
      value: f.value,
    };
    if (f.field_name === "other") {
      // 'other' rows go into the array; their subcategory tags them.
      other.push({ subcategory: f.topic_subcategory, value: f.value });
      continue;
    }
    // Key format: "subcategory.field_name" so the model can disambiguate
    // multiple subcategories sharing similar field names in the future.
    const key = `${f.topic_subcategory}.${f.field_name}`;
    if (f.topic_category === "identity") identity[key] = f.value;
    else if (f.topic_category === "operational") operational[key] = f.value;
    else if (f.topic_category === "behavioral") behavioral[key] = f.value;
    else if (f.topic_category === "concerns") concerns[key] = f.value;
  }

  return {
    prompt_block: {
      identity,
      operational,
      behavioral,
      concerns,
      other,
      facts_returned: kept.length,
      facts_dropped: dropped,
    },
    fact_ids_for_citation,
  };
}

/**
 * Render the Brain block as a short human-readable string for use in
 * proactive Slack digests, briefings, or other non-prompt surfaces
 * where the JSON shape is overkill.
 *
 * Returns an empty string when no facts.
 */
export function renderBrainSummaryText(
  injection: BrainPromptInjection | null,
): string {
  if (!injection) return "";
  const { identity, operational, behavioral, concerns, other } =
    injection.prompt_block;

  const lines: string[] = [];
  if (Object.keys(identity).length) {
    lines.push("Identity:");
    for (const [k, v] of Object.entries(identity)) lines.push(`  • ${k}: ${v}`);
  }
  if (Object.keys(operational).length) {
    lines.push("Operational:");
    for (const [k, v] of Object.entries(operational))
      lines.push(`  • ${k}: ${v}`);
  }
  if (Object.keys(behavioral).length) {
    lines.push("Behavioral:");
    for (const [k, v] of Object.entries(behavioral))
      lines.push(`  • ${k}: ${v}`);
  }
  if (Object.keys(concerns).length) {
    lines.push("Concerns:");
    for (const [k, v] of Object.entries(concerns)) lines.push(`  • ${k}: ${v}`);
  }
  if (other.length) {
    lines.push("Other:");
    for (const o of other) lines.push(`  • ${o.subcategory}: ${o.value}`);
  }
  return lines.join("\n");
}
