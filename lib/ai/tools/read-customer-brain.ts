/**
 * read_customer_brain — Beam tool. Wave 2a.1.
 *
 * Fetches the per-customer Keeper (confirmed canonical facts) for a
 * specific entity. Lets Beam access the Keeper from any scope, not
 * just /customer/[entityId] where the customer-360 context loader
 * pre-injects it.
 *
 * Read-only, no approval required. Resolves entity_id → customer_id
 * via the latest snapshot (Keeper facts are keyed on customer_id /
 * Chargebee handle, not entity_id). Returns topic-clustered facts
 * via the same shape Wave 2a uses in the customer-360 prompt.
 *
 * Sister tool to read_customer_notes: notes are private AM scratch
 * pads; Keeper facts are curated canonical truth. Use BOTH when
 * answering "what do we know about X" questions — the union gives
 * the fullest picture.
 */

import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { loadBrainForPrompt } from "@/lib/brain/retrieval";
import { retrieveFactsHybrid } from "@/lib/brain/retrieve";
import { recordCitation } from "@/lib/brain/repo";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

export const readCustomerBrainTool: BeaconTool = {
  name: "read_customer_brain",
  description:
    "Read the Keeper (curated canonical facts) for one customer — owner identity, contract terms, platform, comms preference, behavioral patterns, latent risks. Read-only.\n" +
    "Pass `question` for the top-5 most relevant facts (hybrid retrieve + rerank). Omit `question` for the full topic-clustered block (up to 40 facts).\n" +
    "Trigger phrases: \"who's the owner?\", \"what platform are they on?\", \"when did they sign?\", \"do they prefer email or phone?\", \"any latent risks I should know about?\".",
  input_schema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description:
          "The customer's entity_id (UUID). Get this from lookup_customer or from the CONTEXT block.",
        minLength: 8,
      },
      question: {
        type: "string",
        description:
          "Optional — what the user wants to learn (a short phrase, e.g., 'their booking platform', 'comms preferences', 'any churn risks'). When provided, returns the top-5 most semantically relevant facts (hybrid retrieval + rerank). Omit to get the full topic-clustered block.",
        minLength: 3,
      },
    },
    required: ["entity_id"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const entityId =
      typeof args.entity_id === "string" ? args.entity_id.trim() : "";
    const question =
      typeof args.question === "string" ? args.question.trim() : "";
    if (!entityId) {
      return { ok: false, error: "entity_id is required" };
    }

    try {
      // Step 1 — resolve entity_id → customer_id via snapshot. Keeper
      // facts are keyed on customer_id (Chargebee handle), not entity_id.
      const snap = await readLatestSnapshotV2();
      const customer = snap?.customers?.find((c) => c.entity_id === entityId);
      if (!customer) {
        return {
          ok: true,
          summary: `Entity ${entityId.slice(0, 8)} not on the active book — no Keeper entry available.`,
          data: { entity_id: entityId, found: false },
        };
      }
      const cbCustomerId = customer.customer_id;
      if (!cbCustomerId) {
        return {
          ok: true,
          summary: `Entity ${entityId.slice(0, 8)} (${customer.company ?? "?"}) has no Chargebee customer_id — Keeper is keyed on Chargebee handle so no entry exists yet.`,
          data: {
            entity_id: entityId,
            bizname: customer.company ?? null,
            found: false,
          },
        };
      }

      // Wave-1 hybrid path — when the caller supplied a question, route
      // through retrieveFactsHybrid to get a ranked top-5. Cuts prompt
      // bloat by ~85% on focused questions and surfaces the actually-
      // relevant fact, not just "all 40 we have on file".
      if (question) {
        const result = await retrieveFactsHybrid(question, {
          customer_id: cbCustomerId,
          topK: 5,
          candidatesPerStage: 50,
        });

        const facts = result.facts.map((s) => ({
          fact_id: s.fact.fact_id,
          topic_category: s.fact.topic_category,
          topic_subcategory: s.fact.topic_subcategory,
          field_name: s.fact.field_name,
          value: s.fact.value,
          confirmed_at: s.fact.confirmed_at,
          source_type: s.fact.source_type,
          matched_via: s.matched_via,
          relevance_score: s.rerank_score,
          rrf_score: s.rrf_score,
          // SMART-K4 — surface parent linkage so the model can (a) see
          // the relationship in the prompt block and (b) reuse the
          // parent fact_id when classifying a NEW derived child via
          // add_fact_to_brain.
          derived_from: s.fact.derived_from ?? null,
        }));

        // SMART-K1 — bump citation_count on every fact we just returned.
        // Fire-and-forget: don't await (keeps tool latency unchanged) and
        // never propagate errors (recordCitation soft-fails internally).
        // This logs facts as "presented to the model" — a realistic proxy
        // for "actually cited in the answer"; the model emits cite chips
        // selectively but always sees this entire set as context.
        if (facts.length > 0) {
          void recordCitation(facts.map((f) => f.fact_id));
        }

        void logUmbrellaActivity({
          email: ctx.amEmail,
          role: ctx.role,
          am_name: ctx.amName,
          agent: "customer",
          event_name: "beacon_ai:action:read_customer_brain",
          surface: "customer-360",
          entity_id: entityId,
          metadata: {
            tool: "read_customer_brain",
            mode: "hybrid",
            customer_id: cbCustomerId,
            question: question.slice(0, 200),
            facts_returned: facts.length,
            timing_ms: result.timing,
            stages_ran: result.ran,
          },
        });

        if (facts.length === 0) {
          return {
            ok: true,
            summary: `No Keeper facts found for "${question.slice(0, 80)}" on ${customer.company ?? entityId.slice(0, 8)}. The customer may not have any confirmed facts in that area yet, or the question may be too narrow — try the no-question form to see everything we have.`,
            data: {
              entity_id: entityId,
              customer_id: cbCustomerId,
              bizname: customer.company ?? null,
              found: true,
              retrieval_mode: "hybrid",
              question,
              facts_returned: 0,
              facts: [],
            },
          };
        }

        return {
          ok: true,
          summary: `Found ${facts.length} Keeper fact${facts.length === 1 ? "" : "s"} most relevant to "${question.slice(0, 80)}" on ${customer.company ?? entityId.slice(0, 8)}.`,
          data: {
            entity_id: entityId,
            customer_id: cbCustomerId,
            bizname: customer.company ?? null,
            found: true,
            retrieval_mode: "hybrid",
            question,
            facts_returned: facts.length,
            facts,
            // Roadmap-v2-4 — provenance scaffolding for the cite-chip "why"
            // trace. Client side `askWithToolResult` lifts these into the
            // continuation request's extra_citations so chips render the
            // matched_via badges + rerank bar inline.
            candidate_pool_size: result.candidate_pool_size,
            retrieval_timing: result.timing,
            retrieval_ran: result.ran,
          },
        };
      }

      // No question → fall through to the existing dump-all behavior.
      // Step 2 — load the topic-clustered Keeper block.
      const brain = await loadBrainForPrompt(cbCustomerId);
      if (!brain || brain.prompt_block.facts_returned === 0) {
        void logUmbrellaActivity({
          email: ctx.amEmail,
          role: ctx.role,
          am_name: ctx.amName,
          agent: "customer",
          event_name: "beacon_ai:action:read_customer_brain",
          surface: "customer-360",
          entity_id: entityId,
          metadata: {
            tool: "read_customer_brain",
            customer_id: cbCustomerId,
            facts_returned: 0,
          },
        });
        return {
          ok: true,
          summary: `No Keeper entry yet for ${customer.company ?? entityId.slice(0, 8)}. AMs can add facts via the Keeper panel on the Customer 360 page.`,
          data: {
            entity_id: entityId,
            customer_id: cbCustomerId,
            bizname: customer.company ?? null,
            found: true,
            facts_returned: 0,
            brain: null,
          },
        };
      }

      const { prompt_block } = brain;
      const summary = `Found ${prompt_block.facts_returned} confirmed Keeper fact${prompt_block.facts_returned === 1 ? "" : "s"} for ${customer.company ?? entityId.slice(0, 8)} (identity: ${Object.keys(prompt_block.identity).length}, operational: ${Object.keys(prompt_block.operational).length}, behavioral: ${Object.keys(prompt_block.behavioral).length}, concerns: ${Object.keys(prompt_block.concerns).length}, other: ${prompt_block.other.length}).`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:read_customer_brain",
        surface: "customer-360",
        entity_id: entityId,
        metadata: {
          tool: "read_customer_brain",
          customer_id: cbCustomerId,
          facts_returned: prompt_block.facts_returned,
          facts_dropped: prompt_block.facts_dropped,
        },
      });

      return {
        ok: true,
        summary,
        data: {
          entity_id: entityId,
          customer_id: cbCustomerId,
          bizname: customer.company ?? null,
          found: true,
          facts_returned: prompt_block.facts_returned,
          facts_dropped: prompt_block.facts_dropped,
          brain: prompt_block,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  },
};
