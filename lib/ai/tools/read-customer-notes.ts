/**
 * read_customer_notes — Beacon AI tool. Phase F-ai-context.
 *
 * Fetches the private AM notes for a specific customer. Notes are keyed on
 * (am_name, entity_id) — one row per (AM, customer) pair.
 *
 * Role scoping:
 *   - AM    → only the asking AM's own note for this customer (privacy).
 *   - admin / manager → notes from every AM who's written one (oversight).
 *
 * Read-only — no approval required. Audit-logged to umbrella_activity.
 */

import { getNote, listNotesByEntity } from "@/lib/customer/customer-notes";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const MAX_NOTE_PREVIEW = 2000;

function clipPreview(s: string): string {
  if (!s) return "";
  return s.length > MAX_NOTE_PREVIEW
    ? `${s.slice(0, MAX_NOTE_PREVIEW)}\n…[truncated]`
    : s;
}

export const readCustomerNotesTool: BeaconTool = {
  name: "read_customer_notes",
  description:
    "Read the private AM notes saved for a specific customer. Notes are typed by AMs to capture private context that doesn't fit into structured signals (e.g. 'spoke with owner about pricing concerns', 'wife handles billing', 'restructuring barbershop'). Each AM writes their own note per customer — they don't see each other's notes. " +
    "Role-scoped: when an AM asks, returns ONLY that AM's own note for the customer. When a manager or admin asks, returns notes from EVERY AM who has written one for that customer (sorted newest first). " +
    "READ-ONLY tool — no approval required. Use when the user asks about saved notes, prior context, or 'what did I/we write about X'. Pair with lookup_customer if the user references a customer by name rather than entity_id.",
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

    const role = ctx.role;
    const isElevated = role === "admin" || role === "manager";

    try {
      if (isElevated) {
        const all = await listNotesByEntity(entityId);
        const summary =
          all.length === 0
            ? `No private notes saved for entity ${entityId.slice(0, 8)}.`
            : `Found ${all.length} note${all.length === 1 ? "" : "s"} across ${all.length} AM${all.length === 1 ? "" : "s"} for entity ${entityId.slice(0, 8)}.`;

        void logUmbrellaActivity({
          email: ctx.amEmail,
          role: ctx.role,
          am_name: ctx.amName,
          agent: "customer",
          event_name: "beacon_ai:action:read_customer_notes",
          surface: "customer-360",
          entity_id: entityId,
          metadata: {
            tool: "read_customer_notes",
            scope: "all-ams",
            note_count: all.length,
          },
        });

        return {
          ok: true,
          summary,
          data: {
            entity_id: entityId,
            scope: "all-ams",
            note_count: all.length,
            notes: all.map((n) => ({
              am_name: n.am_name,
              bizname: n.bizname,
              note: clipPreview(n.note),
              updated_at: n.updated_at,
            })),
          },
        };
      }

      // AM path — only their own note.
      if (!ctx.amName) {
        return {
          ok: false,
          error:
            "Your account isn't mapped to an AM in BaseSheet yet — contact your manager",
        };
      }
      const own = await getNote(ctx.amName, entityId);
      const summary = own
        ? `Found your saved note for entity ${entityId.slice(0, 8)} (last updated ${own.updated_at}).`
        : `You haven't saved a private note for entity ${entityId.slice(0, 8)} yet.`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:read_customer_notes",
        surface: "customer-360",
        entity_id: entityId,
        metadata: {
          tool: "read_customer_notes",
          scope: "own-am",
          has_note: !!own,
        },
      });

      return {
        ok: true,
        summary,
        data: {
          entity_id: entityId,
          scope: "own-am",
          am_name: ctx.amName,
          note: own
            ? {
                note: clipPreview(own.note),
                updated_at: own.updated_at,
              }
            : null,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  },
};
