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
import { searchFacts } from "@/lib/brain/repo";
import { FIELD_CATALOG } from "@/lib/brain/types";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

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
    "Cross-book search over the Keeper (per-customer confirmed facts). Use when the manager asks a question that spans MULTIPLE customers and needs Keeper context — examples:\n" +
    "  - 'Which customers prefer WhatsApp?'\n" +
    "  - 'Show me all customers on GlossGenius'\n" +
    "  - 'Who has a latent risk flagged?'\n" +
    "  - 'Which customers were sold by Ravishankar N?'\n" +
    "  - 'List everyone where auto-debit history mentions failed transactions'\n\n" +
    "You translate the manager's question into a filter using this schema:\n" +
    describeCatalog() +
    "\n\nFilter shape:\n" +
    "  - topic_category (optional): identity | operational | behavioral | concerns\n" +
    "  - topic_subcategory (optional): one of the schema names above\n" +
    "  - field_name (optional): a named field for the chosen subcategory OR 'other'\n" +
    "  - value_contains (optional): substring (case-insensitive) to ILIKE-match in the value column\n\n" +
    "At least ONE of these filters must be provided. Combine them when the question implies a specific field (e.g. 'who prefers WhatsApp' → topic_subcategory='comms_preference', field_name='preferred_channel', value_contains='WhatsApp').\n\n" +
    "Returns up to 50 matching customer rows by default (200 max). Each row carries: customer_id, entity_id, bizname, am_name, the matched fact (topic, field, value, confirmed_at). Use the rows to compose a table or narrative answer.\n\n" +
    "Manager + admin only — AMs use read_customer_brain for their own customers. Read-only, auto-approves.",
  input_schema: {
    type: "object",
    properties: {
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
          "Case-insensitive substring to match in the value column (ILIKE %X%).",
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
          "Skip the first N rows. Used for pagination when an earlier result trimmed at 20 and the user asked for more. Example: 'show next 20' → offset=20. Combine with limit to scroll a window.",
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
      !topic_category &&
      !topic_subcategory &&
      !field_name &&
      !value_contains
    ) {
      return {
        ok: false,
        error:
          "At least one filter is required (topic_category, topic_subcategory, field_name, or value_contains). Cross-book queries with no filter would return too many rows.",
      };
    }

    try {
      const { rows: facts, total } = await searchFacts({
        topic_category,
        topic_subcategory,
        field_name,
        value_contains,
        limit,
        offset,
      });

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
            topic_category,
            topic_subcategory,
            field_name,
            value_contains,
            rows: 0,
          },
        });
        const filterSummary = describeFilter({
          topic_category,
          topic_subcategory,
          field_name,
          value_contains,
        });
        return {
          ok: true,
          summary: `No matching Keeper facts for ${filterSummary}.`,
          data: {
            filter: {
              topic_category: topic_category ?? null,
              topic_subcategory: topic_subcategory ?? null,
              field_name: field_name ?? null,
              value_contains: value_contains ?? null,
            },
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
        };
      });

      const filterSummary = describeFilter({
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
          topic_category,
          topic_subcategory,
          field_name,
          value_contains,
          rows: rows.length,
          total,
          offset,
          limit,
        },
      });

      const pageInfo =
        total > rows.length
          ? ` (page ${Math.floor(offset / limit) + 1}: rows ${offset + 1}-${offset + rows.length} of ${total} total)`
          : "";

      return {
        ok: true,
        summary: `Found ${total} Keeper fact${total === 1 ? "" : "s"} matching ${filterSummary}${pageInfo}.`,
        data: {
          filter: {
            topic_category: topic_category ?? null,
            topic_subcategory: topic_subcategory ?? null,
            field_name: field_name ?? null,
            value_contains: value_contains ?? null,
          },
          rows,
          row_count: rows.length,
          total,
          offset,
          limit,
          has_more: total > offset + rows.length,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  },
};

function describeFilter(opts: {
  topic_category?: string;
  topic_subcategory?: string;
  field_name?: string;
  value_contains?: string;
}): string {
  const parts: string[] = [];
  if (opts.topic_category) parts.push(`category=${opts.topic_category}`);
  if (opts.topic_subcategory)
    parts.push(`subcategory=${opts.topic_subcategory}`);
  if (opts.field_name) parts.push(`field=${opts.field_name}`);
  if (opts.value_contains) parts.push(`value~"${opts.value_contains}"`);
  return parts.length ? parts.join(", ") : "any";
}
