/**
 * get_customer_from_metabase — Beam tool. META-A1.
 *
 * Self-healing Metabase BaseSheet fallback. When a customer's Keeper is
 * empty (e.g. recently bootstrapped, or never touched), Beam can't answer
 * basic identity / contract / platform questions and refuses. This tool
 * pulls the live BaseSheet row for the entity, returns the requested
 * fields to the model so the answer lands NOW, AND fires write-backs into
 * Keeper as confirmed/basesheet facts so the next read is a Keeper hit.
 *
 * Read-only with respect to BaseSheet (Metabase public CSV); fires
 * fire-and-forget writes to beacon_brain_facts via writeBrainFact. Each
 * field write is soft-failed independently so one rejected fact (semantic
 * conflict, idempotency duplicate, etc.) doesn't poison the whole batch.
 *
 * The response shape gives the model BOTH the structured field values
 * AND a count of how many facts got written to Keeper — so it can answer
 * the user's question now AND know that future reads on the same fields
 * will hit Keeper directly.
 *
 * Trigger phrases: "what platform are they on?", "when did they sign up?",
 * "who's their AE?", "are they live on Zoca?".
 */

import "server-only";

import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { fetchBaseSheet } from "@/lib/customer/metabase";
import { writeBrainFact } from "@/lib/brain/repo";
import type { BrainFactWrite } from "@/lib/brain/types";
import type { BaseSheetRow } from "@/lib/customer/types";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const SYSTEM_EMAIL = "system-metabase-fallback@beacon.zoca";

/**
 * Canonical BaseSheet → Keeper taxonomy mapping. Each entry maps a
 * BaseSheet column to a (topic_category, topic_subcategory, field_name)
 * triple. `value_fn` shapes the raw column into a fact value (some columns
 * get a labeled prefix when they map to a generic 'other' slot, so the
 * Keeper still reads cleanly).
 *
 * Skipped columns (intentionally NOT mapped — see report notes):
 *   - bizname             — no business_profile slot; already on snapshot
 *   - am_name             — `current_am` is DERIVED (synthesized from
 *                            snapshot, not stored); writing duplicates state
 *   - phone_number        — owner_info has no phone slot; rare query target
 *   - churn_potential_*   — operational state, not canonical truth
 *   - open_tickets_30d    — operational state
 *   - sp_name             — no sales-pod slot in the catalog
 */
interface BaseSheetMapping {
  bs_column: keyof BaseSheetRow;
  topic_category: BrainFactWrite["topic_category"];
  topic_subcategory: BrainFactWrite["topic_subcategory"];
  field_name: string;
  /** Shape the raw column value into a fact-ready string. Empty result skips. */
  value_fn: (raw: string) => string;
}

const BASESHEET_TO_KEEPER: ReadonlyArray<BaseSheetMapping> = [
  // identity/sold_by/sold_by_ae — mirrors bootstrap.ts. AE of record.
  {
    bs_column: "ae_name",
    topic_category: "identity",
    topic_subcategory: "sold_by",
    field_name: "sold_by_ae",
    value_fn: (raw) => raw.trim(),
  },
  // identity/sold_by/sold_at — mirrors bootstrap.ts. Onboarding date.
  {
    bs_column: "ob_date",
    topic_category: "identity",
    topic_subcategory: "sold_by",
    field_name: "sold_at",
    value_fn: (raw) => {
      const v = raw.trim();
      return v && v.toUpperCase() !== "N/A" ? v : "";
    },
  },
  // identity/owner_info/other — owner_info has no email slot; use 'other'
  // with a labeled prefix so the value reads as a discrete fact.
  {
    bs_column: "app_email",
    topic_category: "identity",
    topic_subcategory: "owner_info",
    field_name: "other",
    value_fn: (raw) => {
      const v = raw.trim();
      return v ? `app_email: ${v}` : "";
    },
  },
  // operational/contract/mrr_amount — mirrors bootstrap.ts. Tagged as
  // BaseSheet so it's distinguishable from the Chargebee variant.
  {
    bs_column: "total_monthly_revenue",
    topic_category: "operational",
    topic_subcategory: "contract",
    field_name: "mrr_amount",
    value_fn: (raw) => {
      const v = raw.trim();
      return v ? `${v} (BaseSheet)` : "";
    },
  },
  // operational/contract/other — chrone_zoca_status (active / paused /
  // canceled / future). No canonical contract-status slot in v1 catalog;
  // the labeled 'other' keeps the value retrievable.
  {
    bs_column: "chrone_zoca_status",
    topic_category: "operational",
    topic_subcategory: "contract",
    field_name: "other",
    value_fn: (raw) => {
      const v = raw.trim();
      return v ? `zoca_status: ${v}` : "";
    },
  },
];

interface FieldWriteback {
  bs_column: string;
  topic_category: string;
  topic_subcategory: string;
  field_name: string;
  value: string;
  written: boolean;
  error?: string;
}

export const getCustomerFromMetabaseTool: BeaconTool = {
  name: "get_customer_from_metabase",
  description:
    "Live BaseSheet (Metabase) fallback for one customer. Use when the Keeper has no entry for a basic identity/contract question — for newly-bootstrapped customers, or when read_customer_brain returned empty. Returns AE, onboarding date, app email, MRR, and Zoca contract status pulled fresh from BaseSheet, AND silently writes the values back into the Keeper as confirmed/basesheet facts so the next ask is a Keeper hit. Self-healing — every call compounds.\n" +
    "Read-only with respect to BaseSheet; fires fire-and-forget Keeper writes. No approval card.\n" +
    "Trigger phrases: \"what platform are they on?\" (when Keeper has no integration entry), \"who's their AE?\", \"when did they sign up?\", \"are they live on Zoca?\", \"what's their MRR?\" — only after read_customer_brain returned empty or the user asked for a fresh pull.",
  input_schema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description:
          "The customer's entity_id (UUID). Resolve via lookup_customer or from CONTEXT first.",
        minLength: 8,
      },
      force_refetch: {
        type: "boolean",
        description:
          "Optional. Ignored for v1 — BaseSheet is always pulled fresh (no Keeper cache short-circuit). Reserved for the v2 cache-aware variant. Defaults to false.",
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

    const t0 = Date.now();

    try {
      // Step 1 — resolve entity_id → cb_customer_id via the latest snapshot.
      // BaseSheet rows carry both entity_id and customer_id, so the snapshot
      // lookup is technically redundant for the row match, but we still
      // need the cb_customer_id for the Keeper write key.
      const snap = await readLatestSnapshotV2();
      const customer = snap?.customers?.find((c) => c.entity_id === entityId);

      // Step 2 — fetch BaseSheet. Live pull every call; the CSV is cheap
      // (~1-2s) and freshness matters when the Keeper is empty.
      const baseSheet = await fetchBaseSheet();
      const metabaseMs = Date.now() - t0;
      const row =
        baseSheet.byEntityId[entityId] ??
        // Fallback: try by customer_id if the snapshot has it but the
        // entity_id index missed (rare; defensive only).
        (customer?.customer_id ? baseSheet.byCustomerId[customer.customer_id] : undefined);

      if (!row) {
        void logUmbrellaActivity({
          email: ctx.amEmail,
          role: ctx.role,
          am_name: ctx.amName,
          agent: "customer",
          event_name: "beacon_ai:action:get_customer_from_metabase",
          surface: "customer-360",
          entity_id: entityId,
          metadata: {
            tool: "get_customer_from_metabase",
            found: false,
            metabase_query_ms: metabaseMs,
          },
        });
        return {
          ok: true,
          summary: `Entity ${entityId.slice(0, 8)} not in BaseSheet — no Metabase data available.`,
          data: {
            entity_id: entityId,
            found: false,
            bizname: customer?.company ?? null,
            customer_id: customer?.customer_id ?? null,
          },
        };
      }

      const cbCustomerId = (row.customer_id || customer?.customer_id || "").trim();

      // Step 3 — build the structured field map for the model.
      const fields: Record<string, string> = {
        bizname: row.bizname,
        am_name: row.am_name,
        ae_name: row.ae_name,
        sp_name: row.sp_name,
        app_email: row.app_email,
        phone_number: row.phone_number,
        total_monthly_revenue: row.total_monthly_revenue,
        chrone_zoca_status: row.chrone_zoca_status,
        ob_date: row.ob_date,
        churn_potential_flag: row.churn_potential_flag,
        churn_potential_status: row.churn_potential_status,
        open_tickets_30d: row.open_tickets_30d,
      };

      // Strip empty values so the model's response payload stays terse.
      const nonEmpty: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) {
        const trimmed = (v ?? "").trim();
        if (trimmed) nonEmpty[k] = trimmed;
      }

      // Step 4 — write each mapped field back to Keeper. Soft-fail per-fact
      // so one rejected write (semantic conflict, idempotency dedupe, etc.)
      // doesn't drop the rest. We DO await each so the model's response
      // payload truthfully reports how many landed.
      const writebacks: FieldWriteback[] = [];
      if (cbCustomerId) {
        const stamp = new Date().toISOString();
        const sourceRef = `metabase:basesheet:${stamp}`;
        for (const m of BASESHEET_TO_KEEPER) {
          const raw = (row[m.bs_column] as string | undefined) ?? "";
          const value = m.value_fn(raw);
          if (!value) continue;
          const writeback: FieldWriteback = {
            bs_column: String(m.bs_column),
            topic_category: m.topic_category,
            topic_subcategory: m.topic_subcategory,
            field_name: m.field_name,
            value,
            written: false,
          };
          try {
            const result = await writeBrainFact({
              customer_id: cbCustomerId,
              topic_category: m.topic_category,
              topic_subcategory: m.topic_subcategory,
              field_name: m.field_name,
              value,
              source_type: "basesheet",
              source_ref: sourceRef,
              confirmed_by_email: SYSTEM_EMAIL,
            });
            writeback.written = !!result;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            writeback.error = msg.slice(0, 200);
            // Don't fail the tool — semantic conflicts and dedupe rejections
            // are expected and recoverable. The model still gets the value.
            console.warn(
              `[get_customer_from_metabase] writeback failed for ${cbCustomerId}/${m.topic_subcategory}/${m.field_name}: ${writeback.error}`,
            );
          }
          writebacks.push(writeback);
        }
      }

      const factsWritten = writebacks.filter((w) => w.written).length;
      const factsFailed = writebacks.filter((w) => !!w.error).length;

      const fieldsCount = Object.keys(nonEmpty).length;
      const summary =
        `BaseSheet for ${row.bizname || cbCustomerId || entityId.slice(0, 8)}: ` +
        `${fieldsCount} field${fieldsCount === 1 ? "" : "s"} returned. ` +
        `Wrote ${factsWritten} fact${factsWritten === 1 ? "" : "s"} back to Keeper ` +
        `(${factsFailed} skipped)` +
        (cbCustomerId ? "." : " — no Chargebee customer_id, write-back skipped.");

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:get_customer_from_metabase",
        surface: "customer-360",
        entity_id: entityId,
        metadata: {
          tool: "get_customer_from_metabase",
          entity_id: entityId,
          customer_id: cbCustomerId || null,
          fields_returned: fieldsCount,
          facts_written_back: factsWritten,
          facts_writeback_failed: factsFailed,
          metabase_query_ms: metabaseMs,
        },
      });

      return {
        ok: true,
        summary,
        data: {
          entity_id: entityId,
          customer_id: cbCustomerId || null,
          bizname: row.bizname || customer?.company || null,
          found: true,
          fields: nonEmpty,
          writeback: {
            facts_written: factsWritten,
            facts_failed: factsFailed,
            details: writebacks,
          },
          metabase_query_ms: metabaseMs,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:get_customer_from_metabase:error",
        surface: "customer-360",
        entity_id: entityId,
        metadata: {
          tool: "get_customer_from_metabase",
          error: msg.slice(0, 200),
        },
      });
      return { ok: false, error: `BaseSheet fetch failed: ${msg}` };
    }
  },
};
