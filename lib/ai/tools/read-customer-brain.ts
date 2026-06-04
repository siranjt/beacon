/**
 * read_customer_brain — Beacon AI tool. Wave 2a.1.
 *
 * Fetches the per-customer Brain (confirmed canonical facts) for a
 * specific entity. Lets Beacon access the Brain from any scope, not
 * just /customer/[entityId] where the customer-360 context loader
 * pre-injects it.
 *
 * Read-only, no approval required. Resolves entity_id → customer_id
 * via the latest snapshot (Brain facts are keyed on customer_id /
 * Chargebee handle, not entity_id). Returns topic-clustered facts
 * via the same shape Wave 2a uses in the customer-360 prompt.
 *
 * Sister tool to read_customer_notes: notes are private AM scratch
 * pads; Brain facts are curated canonical truth. Use BOTH when
 * answering "what do we know about X" questions — the union gives
 * the fullest picture.
 */

import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { loadBrainForPrompt } from "@/lib/brain/retrieval";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

export const readCustomerBrainTool: BeaconTool = {
  name: "read_customer_brain",
  description:
    "Read the Beacon Brain (confirmed canonical facts) for a specific customer. The Brain holds curated per-customer truth: owner identity (name, decision style), how they were sold (AE, sale date, promise), contract terms (start date, MRR, custom pricing), integration platform, behavioral patterns (payment timing, comms preference, seasonal), and open concerns (latent risks, next-call agenda). Facts are auto-confirmed at bootstrap from BaseSheet + Chargebee for the high-trust subset, and AM-confirmed for everything else. " +
    "Reach for this tool when the user asks about ANYTHING that might be a stored fact: 'who's the owner', 'when did they sign', 'what's their MRR', 'what platform are they on', 'do they prefer email or phone', 'any latent risks I should know about', 'how was this sold'. Pair with lookup_customer if the user names a customer by name rather than entity_id. " +
    "Read-only — no approval required. Returns topic-clustered facts ready for the model to quote directly. If no Brain entry exists for the customer, say so plainly — the AM can add facts via the Brain panel.",
  input_schema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description:
          "The customer's entity_id (UUID). Get this from lookup_customer or from the CONTEXT block.",
        minLength: 8,
      },
    },
    required: ["entity_id"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const entityId =
      typeof args.entity_id === "string" ? args.entity_id.trim() : "";
    if (!entityId) {
      return { ok: false, error: "entity_id is required" };
    }

    try {
      // Step 1 — resolve entity_id → customer_id via snapshot. Brain
      // facts are keyed on customer_id (Chargebee handle), not entity_id.
      const snap = await readLatestSnapshotV2();
      const customer = snap?.customers?.find((c) => c.entity_id === entityId);
      if (!customer) {
        return {
          ok: true,
          summary: `Entity ${entityId.slice(0, 8)} not on the active book — no Brain entry available.`,
          data: { entity_id: entityId, found: false },
        };
      }
      const cbCustomerId = customer.customer_id;
      if (!cbCustomerId) {
        return {
          ok: true,
          summary: `Entity ${entityId.slice(0, 8)} (${customer.company ?? "?"}) has no Chargebee customer_id — Brain is keyed on Chargebee handle so no entry exists yet.`,
          data: {
            entity_id: entityId,
            bizname: customer.company ?? null,
            found: false,
          },
        };
      }

      // Step 2 — load the topic-clustered Brain block.
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
          summary: `No Brain entry yet for ${customer.company ?? entityId.slice(0, 8)}. AMs can add facts via the Brain panel on the Customer 360 page.`,
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
      const summary = `Found ${prompt_block.facts_returned} confirmed Brain fact${prompt_block.facts_returned === 1 ? "" : "s"} for ${customer.company ?? entityId.slice(0, 8)} (identity: ${Object.keys(prompt_block.identity).length}, operational: ${Object.keys(prompt_block.operational).length}, behavioral: ${Object.keys(prompt_block.behavioral).length}, concerns: ${Object.keys(prompt_block.concerns).length}, other: ${prompt_block.other.length}).`;

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
