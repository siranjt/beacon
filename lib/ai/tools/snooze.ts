/**
 * snooze_customer — Beacon AI tool. Phase E-16 Wave 1.
 *
 * Hides a customer from the AM's default triage filters for N days. Re-uses
 * the existing repository at `lib/customer/snooze.ts` so the data model is
 * identical to the manual snooze button on the customer card — no new
 * schema, no diverging code paths.
 */

import { snoozeCustomer } from "@/lib/customer/snooze";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const ALLOWED_DAYS = [1, 3, 7, 14, 30] as const;

export const snoozeCustomerTool: BeaconTool = {
  name: "snooze_customer",
  description:
    "Snooze a customer — temporarily hide them from the AM's default triage filters for a fixed number of days. Use this when the AM has decided no action is needed on this customer right now (e.g. they just heard back from the owner, the customer is on vacation, or they're waiting on a third party). Pick a duration that matches the situation: 1-3 days for an active wait, 7 for a typical 'check back next week', 14 for an established hand-off, 30 for a long-term pause. Always include a one-line `reason` so the AM and their manager can audit later.",
  input_schema: {
    type: "object",
    properties: {
      customer_id: {
        type: "string",
        description:
          "The entity_id of the customer being snoozed. Required. Must match the customer the AM is currently viewing.",
      },
      days: {
        type: "integer",
        enum: [1, 3, 7, 14, 30],
        description:
          "How many days to snooze for. Pick from the allowed list: 1, 3, 7, 14, or 30.",
      },
      reason: {
        type: "string",
        description:
          "Short, plain-English reason for the snooze (e.g. 'Owner on vacation until Monday', 'Waiting on billing dispute resolution'). Helps the AM audit later.",
        maxLength: 280,
      },
      bizname: {
        type: "string",
        description:
          "ALWAYS include — the customer's business name from CONTEXT (e.g. 'Acme Salon'). Shown on the approval card so the AM sees who they're snoozing.",
        maxLength: 200,
      },
    },
    required: ["customer_id", "days", "bizname"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const days = typeof args.days === "number" ? args.days : Number(args.days);
    if (!ALLOWED_DAYS.includes(days as (typeof ALLOWED_DAYS)[number])) {
      return {
        ok: false,
        error: `days must be one of ${ALLOWED_DAYS.join(", ")}`,
      };
    }
    if (!ctx.amName) {
      return {
        ok: false,
        error:
          "Your account isn't mapped to an AM in BaseSheet yet — snooze writes are keyed on am_name.",
      };
    }
    const reason =
      typeof args.reason === "string" && args.reason.trim()
        ? args.reason.trim().slice(0, 280)
        : null;

    try {
      const result = await snoozeCustomer(ctx.amName, ctx.customerId, days, {
        customer_id: ctx.cbCustomerId,
        bizname: ctx.customerName,
        reason,
      });

      const label = ctx.customerName ?? ctx.customerId;
      const summary = `Snoozed ${label} for ${days} day${days === 1 ? "" : "s"}${reason ? ` — ${reason}` : ""}.`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:snooze_customer",
        surface: "customer-360",
        entity_id: ctx.customerId,
        metadata: {
          source: "beacon_ai",
          tool: "snooze_customer",
          days,
          reason,
          snoozed_until: result.snoozed_until,
          bizname: ctx.customerName,
        },
      });

      return {
        ok: true,
        summary,
        data: {
          snoozed_until: result.snoozed_until,
          days,
          reason,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:snooze_customer:error",
        surface: "customer-360",
        entity_id: ctx.customerId,
        metadata: { source: "beacon_ai", error: msg, days },
      });
      return { ok: false, error: msg };
    }
  },
};
