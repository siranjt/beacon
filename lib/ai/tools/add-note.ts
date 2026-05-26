/**
 * add_note — Beacon AI tool. Phase E-16 Wave 1.
 *
 * Saves / overwrites the AM's private note on this customer. Re-uses
 * `lib/customer/customer-notes.ts` — the same backing store as the inline
 * note editor on the customer card. There is one note per (am_name,
 * entity_id), so this is an upsert rather than an append.
 *
 * If you want true append semantics later (newest-first journal), that's a
 * Wave 2 schema change to customer_notes — not a tool-side workaround.
 */

import { getNote, upsertNote } from "@/lib/customer/customer-notes";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const MAX_NOTE_LEN = 4000;

export const addNoteTool: BeaconTool = {
  name: "add_note",
  description:
    "Save (or update) the AM's private note on this customer. Use this when the conversation surfaces context worth capturing — owner mood, decision history, pending follow-ups, context the next AM should know. The note is private to this AM and survives across views and devices. There is ONE note per AM-customer pair (not a journal), so when adding new context, draft the FULL replacement body — Beacon will append to the existing note for the AM rather than overwrite blindly. Be specific and dated where it helps (e.g. 'May 26 — owner said they're moving to a new shop in July, holding off on launch until then').",
  input_schema: {
    type: "object",
    properties: {
      customer_id: {
        type: "string",
        description: "The entity_id of the customer this note is for. Required.",
      },
      body: {
        type: "string",
        description:
          "The note body. Be concrete and specific. Include a date prefix (e.g. 'May 26 — ...') when the note records something time-sensitive. Maximum 4000 characters.",
        minLength: 1,
        maxLength: 4000,
      },
      bizname: {
        type: "string",
        description:
          "ALWAYS include — the customer's business name from CONTEXT (e.g. 'Acme Salon'). Shown on the approval card so the AM sees who the note is for.",
        maxLength: 200,
      },
    },
    required: ["customer_id", "body", "bizname"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const incomingBody =
      typeof args.body === "string" ? args.body.trim() : "";
    if (!incomingBody) {
      return { ok: false, error: "body must be a non-empty string" };
    }
    if (incomingBody.length > MAX_NOTE_LEN) {
      return {
        ok: false,
        error: `body too long (max ${MAX_NOTE_LEN} chars, got ${incomingBody.length})`,
      };
    }
    if (!ctx.amName) {
      return {
        ok: false,
        error:
          "Your account isn't mapped to an AM in BaseSheet yet — note writes are keyed on am_name.",
      };
    }

    try {
      // Append rather than overwrite: read existing, prepend the new content
      // so the most recent context is at the top. customer_notes is a
      // single-row-per-pair store, so we have to compose the final string
      // ourselves before upsert.
      const existing = await getNote(ctx.amName, ctx.customerId);
      const existingBody = existing?.note?.trim() ?? "";
      const final =
        existingBody.length > 0
          ? `${incomingBody}\n\n--- previous ---\n${existingBody}`.slice(0, MAX_NOTE_LEN)
          : incomingBody;

      await upsertNote(ctx.amName, ctx.customerId, final, {
        customer_id: ctx.cbCustomerId,
        bizname: ctx.customerName,
      });

      const label = ctx.customerName ?? ctx.customerId;
      const preview =
        incomingBody.length > 80
          ? `${incomingBody.slice(0, 77)}...`
          : incomingBody;
      const ack = `Saved note on ${label}: "${preview}"`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:add_note",
        surface: "customer-360",
        entity_id: ctx.customerId,
        metadata: {
          source: "beacon_ai",
          tool: "add_note",
          note_length: incomingBody.length,
          note_preview: preview,
          had_prior_note: existingBody.length > 0,
          bizname: ctx.customerName,
        },
      });

      return {
        ok: true,
        summary: ack,
        data: { note_length: final.length, appended: existingBody.length > 0 },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:add_note:error",
        surface: "customer-360",
        entity_id: ctx.customerId,
        metadata: { source: "beacon_ai", error: msg },
      });
      return { ok: false, error: msg };
    }
  },
};
