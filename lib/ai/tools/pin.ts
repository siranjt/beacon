/**
 * pin_customer — Beacon AI tool. Phase E-16 Wave 1.
 *
 * Pins / unpins a customer to the AM's pinned list (top-of-book for
 * follow-through). Re-uses `lib/customer/pinned-customers.ts`.
 *
 * The underlying repository's primitive is `togglePinned`, but the tool
 * exposes an explicit boolean `pin` parameter so Claude can request a
 * specific desired-state rather than guessing the toggle direction. We
 * read the current state, then call toggle only if the desired state
 * differs — that gives idempotent semantics without changing the repo.
 */

import { isPinned, togglePinned } from "@/lib/customer/pinned-customers";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

export const pinCustomerTool: BeaconTool = {
  name: "pin_customer",
  description:
    "Pin or unpin a customer. Pinned customers are surfaced at the top of the AM's book and on Monday Briefing as priority follow-ups. Use this when the AM has signalled (in the conversation or via their data) that this customer needs more attention than the score alone suggests — for example a hot lead, a churn-save save in progress, or a manager-flagged escalation. Set `pin: true` to add to the pinned list, `pin: false` to remove. The action is idempotent — pinning an already-pinned customer (or unpinning an unpinned one) is a no-op.",
  input_schema: {
    type: "object",
    properties: {
      customer_id: {
        type: "string",
        description:
          "The entity_id of the customer to pin/unpin. Required. Must match the customer the AM is currently viewing.",
      },
      pin: {
        type: "boolean",
        description:
          "Desired pin state. `true` to pin (add to top-of-book list), `false` to unpin (remove).",
      },
    },
    required: ["customer_id", "pin"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const desired = args.pin === true;
    if (typeof args.pin !== "boolean") {
      return { ok: false, error: "pin must be a boolean" };
    }
    if (!ctx.amName) {
      return {
        ok: false,
        error:
          "Your account isn't mapped to an AM in BaseSheet yet — pin writes are keyed on am_name.",
      };
    }

    try {
      const currentlyPinned = await isPinned(ctx.amName, ctx.customerId);

      if (currentlyPinned === desired) {
        // Already in the desired state — idempotent success, no DB write.
        const label = ctx.customerName ?? ctx.customerId;
        const summary = desired
          ? `${label} is already pinned — no change.`
          : `${label} wasn't pinned — no change.`;

        void logUmbrellaActivity({
          email: ctx.amEmail,
          role: ctx.role,
          am_name: ctx.amName,
          agent: "customer",
          event_name: "beacon_ai:action:pin_customer",
          surface: "customer-360",
          entity_id: ctx.customerId,
          metadata: {
            source: "beacon_ai",
            tool: "pin_customer",
            desired_pin: desired,
            already_in_state: true,
            bizname: ctx.customerName,
          },
        });

        return {
          ok: true,
          summary,
          data: { pinned: desired, no_op: true },
        };
      }

      const result = await togglePinned(ctx.amName, ctx.customerId, {
        customer_id: ctx.cbCustomerId,
        bizname: ctx.customerName,
      });

      const label = ctx.customerName ?? ctx.customerId;
      const summary = result.pinned ? `Pinned ${label}.` : `Unpinned ${label}.`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:pin_customer",
        surface: "customer-360",
        entity_id: ctx.customerId,
        metadata: {
          source: "beacon_ai",
          tool: "pin_customer",
          desired_pin: desired,
          new_pin_state: result.pinned,
          bizname: ctx.customerName,
        },
      });

      return { ok: true, summary, data: { pinned: result.pinned } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:pin_customer:error",
        surface: "customer-360",
        entity_id: ctx.customerId,
        metadata: { source: "beacon_ai", error: msg, desired_pin: desired },
      });
      return { ok: false, error: msg };
    }
  },
};
