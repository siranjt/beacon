/**
 * add_fact_to_brain — Beam tool. Brain Wave 2a.2.
 *
 * Lets AMs grow the Keeper by typing facts into Beam conversation:
 *   "save: owner prefers WhatsApp, hates email"
 *   "remember they only respond after 6pm EST"
 *   "the platform is GlossGenius, contract renews September"
 *
 * The MODEL classifies the AM's free-form content into structured
 * (topic_category, topic_subcategory, field_name) using the
 * FIELD_CATALOG it sees in the prompt. The model fills the tool's
 * args; this executor just validates the combination and writes.
 *
 * Confirmation card required (write tool, NOT auto-approve). The AM
 * sees the classified proposal before approval — catches mis-
 * categorizations (Haiku is good but not perfect).
 *
 * Conflict handling (v1):
 *   - Exact-match idempotency: if existing value == new value, no-op
 *     (silently bump updated_at, return ok with "already known").
 *   - Differing value on a named field: BLOCK with conflict info
 *     UNLESS force=true. AM can resend with force=true to overwrite
 *     (writes a version-log entry on top of the prior value).
 *   - 'other' field rows always insert as new (unlimited per
 *     subcategory by design — long-tail catchall).
 *
 * Semantic Haiku conflict detection ships in Wave 2b alongside the
 * conflict resolution UI. For v1, exact-match keeps the surface area
 * small and the behavior predictable.
 */

import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import {
  writeBrainFact,
  getFactsForCustomer,
  SemanticConflictError,
} from "@/lib/brain/repo";
import {
  FIELD_CATALOG,
  categoryForSubcategory,
  isNamedField,
} from "@/lib/brain/types";
import type {
  TopicCategory,
  TopicSubcategory,
} from "@/lib/brain/types";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

/**
 * Stringified FIELD_CATALOG for inclusion in the tool description so the
 * model knows the schema at classification time. Lists each subcategory's
 * category + named fields.
 */
function describeFieldCatalog(): string {
  const lines: string[] = [];
  for (const sub of Object.keys(FIELD_CATALOG) as TopicSubcategory[]) {
    const entry = FIELD_CATALOG[sub];
    lines.push(
      `  - ${entry.category}/${sub}: ${entry.named_fields.join(", ")}, or "other"`,
    );
  }
  return lines.join("\n");
}

const ALL_SUBCATEGORIES: ReadonlySet<TopicSubcategory> = new Set(
  Object.keys(FIELD_CATALOG) as TopicSubcategory[],
);
const ALL_CATEGORIES: ReadonlySet<TopicCategory> = new Set<TopicCategory>([
  "identity",
  "operational",
  "behavioral",
  "concerns",
]);

export const addFactToBrainTool: BeaconTool = {
  name: "add_fact_to_brain",
  description:
    "Save a confirmed fact about a customer to the Keeper. Use when the AM tells you to 'save', 'remember', 'note that', 'add a fact', or otherwise commits a piece of customer knowledge to canonical truth. The Keeper is the curated per-customer truth store that Beam grounds on across every scope. " +
    "You classify the AM's content into (topic_category, topic_subcategory, field_name, value) using this schema:\n" +
    describeFieldCatalog() +
    "\n\nClassification rules:\n" +
    "1. Pick the subcategory that BEST fits the content semantically. Don't force-fit; if nothing matches well, use field_name='other' under the closest subcategory.\n" +
    "2. field_name MUST be either one of the named fields for the chosen subcategory OR exactly 'other'. Don't invent field names.\n" +
    "3. topic_category MUST match the subcategory's category (e.g. 'comms_preference' is always 'behavioral').\n" +
    "4. value is the AM's content, lightly normalized: full sentences are fine; trim filler words like 'save:' or 'remember that'. Preserve specifics (names, dates, channels).\n" +
    "5. For 'other' rows, the value should be a complete short sentence that the next AM reading it will understand without context.\n\n" +
    "Returns: success summary on write, or a conflict error if a different value already exists for this named field (the AM can resend with force=true to overwrite).",
  input_schema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description:
          "The customer's entity_id (UUID). Get from CONTEXT.identity.entity_id or lookup_customer.",
        minLength: 8,
      },
      topic_category: {
        type: "string",
        enum: ["identity", "operational", "behavioral", "concerns"],
        description: "The top-level category. Must match the subcategory.",
      },
      topic_subcategory: {
        type: "string",
        description:
          "The subcategory from FIELD_CATALOG. See description for the full list.",
      },
      field_name: {
        type: "string",
        description:
          "Either a named field from the subcategory's catalog OR exactly 'other' for long-tail facts.",
      },
      value: {
        type: "string",
        description:
          "The fact's content. Full sentence, specifics preserved, filler trimmed.",
        minLength: 1,
        maxLength: 2000,
      },
      force: {
        type: "boolean",
        description:
          "When true, overwrites an existing differing value at the same (customer, subcategory, named field). Defaults to false. Only use when the AM has explicitly seen the conflict and confirmed they want to overwrite.",
      },
    },
    required: [
      "entity_id",
      "topic_category",
      "topic_subcategory",
      "field_name",
      "value",
    ],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const entityId =
      typeof args.entity_id === "string" ? args.entity_id.trim() : "";
    const topicCategoryRaw =
      typeof args.topic_category === "string" ? args.topic_category : "";
    const topicSubcategoryRaw =
      typeof args.topic_subcategory === "string" ? args.topic_subcategory : "";
    const fieldNameRaw =
      typeof args.field_name === "string" ? args.field_name.trim() : "";
    const value = typeof args.value === "string" ? args.value.trim() : "";
    const force = args.force === true;

    if (!entityId) return { ok: false, error: "entity_id is required" };
    if (!value) return { ok: false, error: "value is required" };

    // Validate category + subcategory.
    if (!ALL_CATEGORIES.has(topicCategoryRaw as TopicCategory)) {
      return {
        ok: false,
        error: `Invalid topic_category '${topicCategoryRaw}'. Must be one of: identity, operational, behavioral, concerns.`,
      };
    }
    const topicCategory = topicCategoryRaw as TopicCategory;

    if (!ALL_SUBCATEGORIES.has(topicSubcategoryRaw as TopicSubcategory)) {
      return {
        ok: false,
        error: `Invalid topic_subcategory '${topicSubcategoryRaw}'. See FIELD_CATALOG for valid values.`,
      };
    }
    const topicSubcategory = topicSubcategoryRaw as TopicSubcategory;

    const expectedCategory = categoryForSubcategory(topicSubcategory);
    if (expectedCategory !== topicCategory) {
      return {
        ok: false,
        error: `topic_category mismatch: '${topicCategory}' but subcategory '${topicSubcategory}' belongs to '${expectedCategory}'.`,
      };
    }

    // Validate field_name: either a named field for this subcategory OR 'other'.
    if (fieldNameRaw !== "other" && !isNamedField(topicSubcategory, fieldNameRaw)) {
      const allowed = FIELD_CATALOG[topicSubcategory].named_fields.join(", ");
      return {
        ok: false,
        error: `Invalid field_name '${fieldNameRaw}' for subcategory '${topicSubcategory}'. Must be one of: ${allowed}, or 'other'.`,
      };
    }

    try {
      // Step 1 — resolve entity_id → customer_id via snapshot.
      const snap = await readLatestSnapshotV2();
      const customer = snap?.customers?.find((c) => c.entity_id === entityId);
      if (!customer) {
        return {
          ok: false,
          error: `Entity ${entityId.slice(0, 8)} not on the active book — can't save Keeper fact.`,
        };
      }
      const cbCustomerId = customer.customer_id;
      if (!cbCustomerId) {
        return {
          ok: false,
          error: `Entity ${entityId.slice(0, 8)} (${customer.company ?? "?"}) has no Chargebee customer_id — Keeper is keyed on Chargebee handle.`,
        };
      }

      // Step 2 — exact-match conflict check (named fields only; 'other'
      // rows always insert as new).
      if (fieldNameRaw !== "other") {
        const existing = await getFactsForCustomer(cbCustomerId, {
          confirmedOnly: false,
        });
        const existingMatch = existing.find(
          (f) =>
            f.topic_subcategory === topicSubcategory &&
            f.field_name === fieldNameRaw,
        );
        if (existingMatch) {
          if (existingMatch.value === value) {
            // Idempotent — fact already known.
            return {
              ok: true,
              summary: `Keeper already has this fact for ${customer.company ?? entityId.slice(0, 8)} (${topicSubcategory}/${fieldNameRaw}). No change.`,
              data: {
                entity_id: entityId,
                customer_id: cbCustomerId,
                fact_id: existingMatch.fact_id,
                idempotent: true,
              },
            };
          }
          if (!force) {
            return {
              ok: false,
              error: `Conflict: Keeper already has ${topicSubcategory}/${fieldNameRaw}="${existingMatch.value}" for ${customer.company ?? entityId.slice(0, 8)}. Resend with force=true to overwrite, or use field_name='other' to keep both.`,
            };
          }
        }
      }

      // Step 3 — write the fact (confirmed, since AM is in the loop).
      // Wave 2b — if AM passed force=true, also override the semantic
      // conflict gate so this write isn't blocked by a near-duplicate.
      let written;
      try {
        written = await writeBrainFact({
          customer_id: cbCustomerId,
          topic_category: topicCategory,
          topic_subcategory: topicSubcategory,
          field_name: fieldNameRaw,
          value,
          source_type: "beacon_ai_conversation",
          source_ref: ctx.amEmail,
          owning_am_email: ctx.amEmail,
          confirmed_by_email: ctx.amEmail,
          force_semantic_conflict: force,
        });
      } catch (e) {
        if (e instanceof SemanticConflictError) {
          return {
            ok: false,
            error: `Near-duplicate detected: this fact looks like an existing one for ${customer.company ?? entityId.slice(0, 8)} ("${e.conflicting_value.slice(0, 100)}", similarity ${(e.similarity * 100).toFixed(0)}%). Resend with force=true if you want both. Existing fact_id: ${e.conflicting_fact_id}.`,
          };
        }
        throw e;
      }

      if (!written) {
        return { ok: false, error: "Failed to write Keeper fact" };
      }

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:add_fact_to_brain",
        surface: "customer-360",
        entity_id: entityId,
        metadata: {
          tool: "add_fact_to_brain",
          customer_id: cbCustomerId,
          fact_id: written.fact_id,
          topic_category: topicCategory,
          topic_subcategory: topicSubcategory,
          field_name: fieldNameRaw,
          force,
          version: written.current_version,
        },
      });

      const verb =
        written.current_version > 1
          ? `Updated`
          : `Saved`;
      return {
        ok: true,
        summary: `${verb} Keeper fact for ${customer.company ?? entityId.slice(0, 8)}: ${topicCategory}/${topicSubcategory}/${fieldNameRaw} = "${value.slice(0, 80)}${value.length > 80 ? "…" : ""}"`,
        data: {
          entity_id: entityId,
          customer_id: cbCustomerId,
          fact_id: written.fact_id,
          topic_category: topicCategory,
          topic_subcategory: topicSubcategory,
          field_name: fieldNameRaw,
          value,
          version: written.current_version,
          idempotent: false,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  },
};
