/**
 * query_brain — Beam tool. Brain Wave 2a.3.
 *
 * Manager-facing cross-book search over the Keeper. Lets you ask things like:
 *   "Which customers prefer WhatsApp?"
 *   "Show me all customers on GlossGenius."
 *   "Who has a latent risk flagged this month?"
 *   "Which customers were sold by Ravishankar N?"
 *
 * The model translates the manager's natural-language question into the
 * structured filter (topic_subcategory, field_name, value_contains).
 * The executor pulls matching confirmed facts and joins to customer
 * identity (bizname, am_name, entity_id) via the latest snapshot.
 *
 * Manager + admin only. AMs can already see facts for their own
 * customers via read_customer_brain — cross-book Keeper search is a
 * leadership concern (handoff planning, pattern discovery, audit).
 *
 * Read-only, auto-approves.
 */

import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { searchFacts, recordCitation } from "@/lib/brain/repo";
import { retrieveFactsHybrid } from "@/lib/brain/retrieve";
import { FIELD_CATALOG } from "@/lib/brain/types";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";
import type { BrainFact } from "@/lib/brain/types";

const MAX_ROWS_DEFAULT = 50;
const MAX_ROWS_HARD = 200;

function describeCatalog(): string {
  const lines: string[] = [];
  for (const sub of Object.keys(FIELD_CATALOG)) {
    const entry = FIELD_CATALOG[sub as keyof typeof FIELD_CATALOG];
    lines.push(
      `  - ${entry.category}/${sub}: ${entry.named_fields.join(", ")}`,
    );
  }
  return lines.join("\n");
}

export const queryBrainTool: BeaconTool = {
  name: "query_brain",
  description:
    "Cross-book search over the Keeper (multi-customer confirmed facts). Two modes: pass `query` (natural language) to hit hybrid semantic + keyword + rerank; pass structured filters (topic_category, topic_subcategory, field_name, value_contains) for deterministic schema lookups with pagination. You can combine them (structured filters AND-narrow the hybrid search). At least one input is required. Returns customer_id, entity_id, bizname, am_name + matched fact.\n" +
    "Schema for structured mode:\n" +
    describeCatalog() +
    "\n\nManager + admin only — AMs must use read_customer_brain for their own customers. Read-only.\n" +
    "Trigger phrases: \"which customers prefer WhatsApp?\", \"show me everyone on GlossGenius\", \"who has a latent risk flagged?\", \"customers worried about pricing\", \"which customers were sold by Ravishankar?\".",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural-language description of what you're looking for (e.g., 'customers worried about pricing', 'AMs who flagged onboarding risk'). When provided, runs hybrid semantic + keyword search + rerank across all confirmed facts. Combine with structured filters to narrow scope.",
        minLength: 3,
      },
      topic_category: {
        type: "string",
        enum: ["identity", "operational", "behavioral", "concerns"],
      },
      topic_subcategory: {
        type: "string",
        description:
          "Subcategory name (e.g. 'comms_preference', 'contract', 'latent_risk'). See description for the full list.",
      },
      field_name: {
        type: "string",
        description:
          "Named field for the chosen subcategory, or 'other' for long-tail facts.",
      },
      value_contains: {
        type: "string",
        description:
          "Case-insensitive substring to match in the value column (ILIKE %X%). Structured-mode only — ignored when `query` is provided.",
        minLength: 1,
      },
      limit: {
        type: "number",
        description:
          "Max rows to return in this page. Default 50, max 200. Use larger limits sparingly.",
        minimum: 1,
        maximum: MAX_ROWS_HARD,
      },
      offset: {
        type: "number",
        description:
          "Skip the first N rows. Used for pagination when an earlier result trimmed at 20 and the user asked for more. Example: 'show next 20' → offset=20. Combine with limit to scroll a window. Structured-mode only — hybrid mode returns the top-50 reranked candidates without pagination.",
        minimum: 0,
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const role = ctx.role;
    if (role !== "admin" && role !== "manager") {
      return {
        ok: false,
        error:
          "query_brain is manager + admin only. Use read_customer_brain for facts about a single customer in your book.",
      };
    }

    const naturalQuery =
      typeof args.query === "string" && args.query.trim().length >= 3
        ? args.query.trim()
        : undefined;
    const topic_category =
      typeof args.topic_category === "string" ? args.topic_category : undefined;
    const topic_subcategory =
      typeof args.topic_subcategory === "string"
        ? args.topic_subcategory
        : undefined;
    const field_name =
      typeof args.field_name === "string" ? args.field_name : undefined;
    const value_contains =
      typeof args.value_contains === "string" ? args.value_contains : undefined;
    const limit =
      typeof args.limit === "number"
        ? Math.max(1, Math.min(MAX_ROWS_HARD, Math.floor(args.limit)))
        : MAX_ROWS_DEFAULT;
    const offset =
      typeof args.offset === "number"
        ? Math.max(0, Math.floor(args.offset))
        : 0;

    if (
      !naturalQuery &&
      !topic_category &&
      !topic_subcategory &&
      !field_name &&
      !value_contains
    ) {
      return {
        ok: false,
        error:
          "At least one input is required (`query` OR one of the structured filters). Cross-book queries with no input would return too many rows.",
      };
    }

    try {
      // Wave-1 hybrid path — when a natural-language query is provided,
      // route through retrieveFactsHybrid. Structured filters (category/
      // subcategory/field) become AND-conditions narrowing the search;
      // value_contains is ignored in this mode because rerank handles
      // substring matching better than ILIKE.
      let facts: BrainFact[];
      let total: number;
      let retrievalMode: "hybrid" | "structured";
      let timing_ms: Record<string, number> | undefined;
      let stages_ran: Record<string, boolean> | undefined;
      // Roadmap-v2-4 — per-fact provenance for the cite-chip "why" trace.
      // Populated in hybrid mode; left null in structured mode (no
      // semantic/keyword ranking to expose).
      let provenanceByFactId: Map<
        string,
        {
          matched_via: Array<"embedding" | "keyword" | "derived_expansion">;
          rrf_score: number;
          rerank_score: number | null;
        }
      > | null = null;
      let candidatePoolSize = 0;

      if (naturalQuery) {
        const result = await retrieveFactsHybrid(naturalQuery, {
          topic_category,
          topic_subcategory,
          field_name,
          // For cross-book, pull more candidates and return more — the
          // manager use case wants breadth over precision.
          candidatesPerStage: 100,
          topK: Math.min(limit, 50),
        });
        facts = result.facts.map((s) => s.fact);
        total = facts.length;
        retrievalMode = "hybrid";
        timing_ms = result.timing as unknown as Record<string, number>;
        stages_ran = result.ran as unknown as Record<string, boolean>;
        provenanceByFactId = new Map(
          result.facts.map((s) => [
            s.fact.fact_id,
            {
              matched_via: s.matched_via,
              rrf_score: s.rrf_score,
              rerank_score: s.rerank_score,
            },
          ]),
        );
        candidatePoolSize = result.candidate_pool_size;
        // SMART-K1 — bump citation_count on every fact presented to the
        // model through the hybrid path. Fire-and-forget (don't await,
        // don't surface errors); the structured search path skips this
        // because it's a deterministic schema lookup, not a relevance-
        // ranked answer to a question.
        if (facts.length > 0) {
          void recordCitation(facts.map((f) => f.fact_id));
        }
      } else {
        const out = await searchFacts({
          topic_category,
          topic_subcategory,
          field_name,
          value_contains,
          limit,
          offset,
        });
        facts = out.rows;
        total = out.total;
        retrievalMode = "structured";
      }

      if (facts.length === 0) {
        void logUmbrellaActivity({
          email: ctx.amEmail,
          role: ctx.role,
          am_name: ctx.amName,
          agent: "customer",
          event_name: "beacon_ai:action:query_brain",
          surface: "customer-360",
          metadata: {
            tool: "query_brain",
            mode: retrievalMode,
            query: naturalQuery ? naturalQuery.slice(0, 200) : undefined,
            topic_category,
            topic_subcategory,
            field_name,
            value_contains,
            rows: 0,
            timing_ms,
            stages_ran,
          },
        });
        const inputSummary = describeInput({
          query: naturalQuery,
          topic_category,
          topic_subcategory,
          field_name,
          value_contains,
        });
        return {
          ok: true,
          summary: `No matching Keeper facts for ${inputSummary}.`,
          data: {
            filter: {
              query: naturalQuery ?? null,
              topic_category: topic_category ?? null,
              topic_subcategory: topic_subcategory ?? null,
              field_name: field_name ?? null,
              value_contains: value_contains ?? null,
            },
            retrieval_mode: retrievalMode,
            rows: [],
            row_count: 0,
          },
        };
      }

      // Step 2 — join to snapshot for bizname/am_name.
      const snap = await readLatestSnapshotV2();
      const byCustomerId = new Map<
        string,
        { bizname: string | null; am_name: string | null; entity_id: string | null }
      >();
      if (snap?.customers) {
        for (const c of snap.customers) {
          if (!c.customer_id) continue;
          // Multi-location: first entity wins for the join; full map could
          // come later if managers ask for it.
          if (!byCustomerId.has(c.customer_id)) {
            byCustomerId.set(c.customer_id, {
              bizname: c.company ?? null,
              am_name: c.am_name ?? null,
              entity_id: c.entity_id ?? null,
            });
          }
        }
      }

      const rows = facts.map((f) => {
        const join = byCustomerId.get(f.customer_id);
        const prov = provenanceByFactId?.get(f.fact_id) ?? null;
        return {
          fact_id: f.fact_id,
          customer_id: f.customer_id,
          entity_id: join?.entity_id ?? null,
          bizname: join?.bizname ?? null,
          am_name: join?.am_name ?? null,
          topic_category: f.topic_category,
          topic_subcategory: f.topic_subcategory,
          field_name: f.field_name,
          value: f.value,
          source_type: f.source_type,
          confirmed_at: f.confirmed_at,
          // Roadmap-v2-4 — hybrid-mode provenance for cite-chip "why" trace.
          // Null on structured-mode rows (no ranking pipeline ran).
          matched_via: prov?.matched_via ?? null,
          rrf_score: prov?.rrf_score ?? null,
          relevance_score: prov?.rerank_score ?? null,
          // SMART-K4 — surface parent linkage. Lets the manager see "this
          // owner_email was derived from owner_info" in the result table,
          // and lets Beam reuse the parent_id when classifying a new
          // derived child via add_fact_to_brain.
          derived_from: f.derived_from ?? null,
        };
      });

      const inputSummary = describeInput({
        query: naturalQuery,
        topic_category,
        topic_subcategory,
        field_name,
        value_contains,
      });

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:query_brain",
        surface: "customer-360",
        metadata: {
          tool: "query_brain",
          mode: retrievalMode,
          query: naturalQuery ? naturalQuery.slice(0, 200) : undefined,
          topic_category,
          topic_subcategory,
          field_name,
          value_contains,
          rows: rows.length,
          total,
          offset: retrievalMode === "structured" ? offset : 0,
          limit,
          timing_ms,
          stages_ran,
        },
      });

      // Pagination only applies to structured mode. Hybrid mode returns
      // the top-K reranked candidates without offset semantics.
      const pageInfo =
        retrievalMode === "structured" && total > rows.length
          ? ` (page ${Math.floor(offset / limit) + 1}: rows ${offset + 1}-${offset + rows.length} of ${total} total)`
          : "";

      const modeLabel =
        retrievalMode === "hybrid" ? " (ranked by relevance)" : "";

      return {
        ok: true,
        summary: `Found ${total} Keeper fact${total === 1 ? "" : "s"} matching ${inputSummary}${modeLabel}${pageInfo}.`,
        data: {
          filter: {
            query: naturalQuery ?? null,
            topic_category: topic_category ?? null,
            topic_subcategory: topic_subcategory ?? null,
            field_name: field_name ?? null,
            value_contains: value_contains ?? null,
          },
          retrieval_mode: retrievalMode,
          rows,
          row_count: rows.length,
          total,
          offset: retrievalMode === "structured" ? offset : 0,
          limit,
          has_more:
            retrievalMode === "structured" && total > offset + rows.length,
          // Roadmap-v2-4 — provenance scaffolding so the client can build
          // the cite-chip "why" trace for hybrid-mode rows.
          candidate_pool_size: candidatePoolSize,
          retrieval_query: naturalQuery ?? null,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  },
};

function describeInput(opts: {
  query?: string;
  topic_category?: string;
  topic_subcategory?: string;
  field_name?: string;
  value_contains?: string;
}): string {
  const parts: string[] = [];
  if (opts.query) parts.push(`query~"${opts.query.slice(0, 60)}"`);
  if (opts.topic_category) parts.push(`category=${opts.topic_category}`);
  if (opts.topic_subcategory)
    parts.push(`subcategory=${opts.topic_subcategory}`);
  if (opts.field_name) parts.push(`field=${opts.field_name}`);
  if (opts.value_contains) parts.push(`value~"${opts.value_contains}"`);
  return parts.length ? parts.join(", ") : "any";
}
