/**
 * mark_contacted_today — Beacon AI tool. Phase E-16 Wave 1.
 *
 * Records that the AM reached out to (or connected with) this customer
 * today via a specific channel. Re-uses `writeAmAction` from
 * `lib/customer/postgres.ts` so the row shows up in the existing am_actions
 * timeline + analytics — identical shape to clicking the "Mark contacted"
 * button on the customer card.
 *
 * Channel mapping:
 *   chat / phone / email / sms / video → all logged as `contacted_connected`
 *   The channel is captured in the note + activity-log metadata so the
 *   downstream slack-am-activity digest can surface it per channel.
 */

import { writeAmAction } from "@/lib/customer/postgres";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const ALLOWED_CHANNELS = ["email", "phone", "chat", "sms", "video"] as const;
type Channel = (typeof ALLOWED_CHANNELS)[number];

export const markContactedTodayTool: BeaconTool = {
  name: "mark_contacted_today",
  description:
    "Log an OUTBOUND touch the AM just made (or is about to make). Pick the `channel` matching how they reached out; add a 1-line `summary` of what happened. Do NOT use for inbound contact from the customer.\n" +
    "Trigger phrases: \"I just texted Maria\", \"about to call them\", \"sent the follow-up email\", \"left them a voicemail\".",
  input_schema: {
    type: "object",
    properties: {
      customer_id: {
        type: "string",
        description: "The entity_id of the customer the AM contacted. Required.",
      },
      channel: {
        type: "string",
        enum: ["email", "phone", "chat", "sms", "video"],
        description:
          "How the AM reached out. Pick `phone` for voice calls, `video` for Zoom/Meet/Teams, `chat` for in-app chat, `sms` for text, `email` for email.",
      },
      summary: {
        type: "string",
        description:
          "Optional 1-line note about what was discussed or attempted (e.g. 'Confirmed onboarding for Thursday', 'Left VM about overdue invoice'). Stored on the am_actions row and appears in the AM-activity digest.",
        maxLength: 500,
      },
      bizname: {
        type: "string",
        description:
          "ALWAYS include — the customer's business name from CONTEXT (e.g. 'Acme Salon'). Shown on the approval card so the AM sees who they're logging a touch for.",
        maxLength: 200,
      },
    },
    required: ["customer_id", "channel", "bizname"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const channel = String(args.channel ?? "") as Channel;
    if (!ALLOWED_CHANNELS.includes(channel)) {
      return {
        ok: false,
        error: `channel must be one of ${ALLOWED_CHANNELS.join(", ")}`,
      };
    }
    if (!ctx.amName) {
      return {
        ok: false,
        error:
          "Your account isn't mapped to an AM in BaseSheet yet — mark-contacted writes are keyed on am_name.",
      };
    }
    const summary =
      typeof args.summary === "string" && args.summary.trim()
        ? args.summary.trim().slice(0, 500)
        : null;

    // Prefix the note with the channel so the existing timeline UI shows
    // the channel without a schema migration on am_actions.
    const noteForRow = summary
      ? `[${channel}] ${summary}`
      : `[${channel}] (contacted via ${channel})`;

    try {
      const id = await writeAmAction({
        am_name: ctx.amName,
        entity_id: ctx.customerId,
        action_type: "contacted_connected",
        note: noteForRow,
        composite_at_action: null,
        reason_code: null,
        follow_up_date: null,
      });

      const label = ctx.customerName ?? ctx.customerId;
      const ack = `Logged ${channel} contact with ${label}${summary ? ` — ${summary}` : ""}.`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:mark_contacted_today",
        surface: "customer-360",
        entity_id: ctx.customerId,
        metadata: {
          source: "beacon_ai",
          tool: "mark_contacted_today",
          channel,
          summary,
          am_action_id: id,
          bizname: ctx.customerName,
        },
      });

      return {
        ok: true,
        summary: ack,
        data: { am_action_id: id, channel, summary_text: summary },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:mark_contacted_today:error",
        surface: "customer-360",
        entity_id: ctx.customerId,
        metadata: { source: "beacon_ai", error: msg, channel },
      });
      return { ok: false, error: msg };
    }
  },
};
