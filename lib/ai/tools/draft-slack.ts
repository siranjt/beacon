/**
 * draft_slack_message — Beacon AI tool. Phase E-16 Wave 2.
 *
 * Same pattern as draft_email_to_contact, but for internal Slack messages.
 * Returns a terse, lowercase Slack-style draft (no greetings, no formal
 * closings). The AM copies it and posts themselves — Beacon does NOT post
 * to Slack.
 *
 * `channel_hint` is optional and surfaced only in the preview ("for
 * #am-discussion"). Beacon doesn't resolve channels — that's a v2.1 gap.
 *
 * NOT idempotent on the executor — re-drafting is intentional (AM wants
 * a different angle).
 */

import Anthropic from "@anthropic-ai/sdk";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { logUmbrellaActivity } from "@/lib/activity/log";
import { listFactsForUser, renderFactsForPrompt } from "@/lib/ai/facts";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const DRAFT_MODEL =
  process.env.ANTHROPIC_DRAFT_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 500;
const MAX_BODY_BRIEF = 1000;
const MAX_CHANNEL_HINT = 120;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

function normalizeChannel(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().slice(0, MAX_CHANNEL_HINT);
  if (!trimmed) return null;
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function buildCustomerSnapshot(c: ScoredCustomerV2 | null): string {
  if (!c) return "(no customer data on file)";
  const lines: string[] = [];
  if (c.company) lines.push(`bizname: ${c.company}`);
  if (c.am_name) lines.push(`am: ${c.am_name}`);
  const s = c.signals_v2;
  if (s) {
    lines.push(
      `health: composite ${s.composite} ${s.stoplight ?? "?"} / tier ${s.tier ?? "?"} / ${s.trajectory_7d ?? "unknown"}`,
    );
    if (s.reason_one_line) lines.push(`reason: ${s.reason_one_line}`);
  }
  const m = c.metrics;
  if (m && typeof m.days_since_out === "number") {
    lines.push(`days since we last reached out: ${m.days_since_out}`);
  }
  const t = c.tickets;
  if (t && (t.open_count ?? t.open_tickets_30d ?? 0) > 0) {
    lines.push(`open tickets: ${t.open_count ?? t.open_tickets_30d}`);
  }
  return lines.join("\n");
}

export const draftSlackMessageTool: BeaconTool = {
  name: "draft_slack_message",
  description:
    "Draft an INTERNAL Slack message about a customer (terse, lowercase, no greetings — internal convention). NOT customer-facing — use draft_email_to_contact for outbound mail. `channel_hint` is shown in the preview; Beam never posts to Slack — AM copies and pastes.\n" +
    "Trigger phrases: \"ping the team about Acme\", \"drop a note in #am-discussion\", \"flag this to my manager\", \"heads-up the AM channel\".",
  input_schema: {
    type: "object",
    properties: {
      customer_id: {
        type: "string",
        description:
          "The entity_id of the customer the message is about. Required. Match against CONTEXT.identity.entity_id, or use lookup_customer first if the customer isn't already in the scope.",
      },
      channel_hint: {
        type: "string",
        description:
          "Optional Slack channel where the AM intends to post (e.g. '#am-discussion', '#billing'). Beacon shows this in the preview but does NOT post.",
        maxLength: MAX_CHANNEL_HINT,
      },
      body_brief: {
        type: "string",
        description:
          "Required. What the message should say. 1-3 short sentences describing intent. Example: 'flag to manager that Acme's billing dispute is escalating, ask whether to loop in finance'.",
        minLength: 1,
        maxLength: MAX_BODY_BRIEF,
      },
    },
    required: ["customer_id", "body_brief"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const bodyBrief =
      typeof args.body_brief === "string" ? args.body_brief.trim() : "";
    if (!bodyBrief)
      return { ok: false, error: "body_brief must be a non-empty string" };
    if (bodyBrief.length > MAX_BODY_BRIEF) {
      return { ok: false, error: `body_brief too long (max ${MAX_BODY_BRIEF})` };
    }
    const channelHintRaw =
      typeof args.channel_hint === "string" ? args.channel_hint : null;
    const channelHint = normalizeChannel(channelHintRaw);

    if (!process.env.ANTHROPIC_API_KEY) {
      return {
        ok: false,
        error: "ANTHROPIC_API_KEY is not configured — can't draft.",
      };
    }

    try {
      const snap = await readLatestSnapshotV2().catch(() => null);
      const customer =
        snap?.customers?.find((c) => c.entity_id === ctx.customerId) ?? null;
      const customerLabel = customer?.company ?? ctx.customerName ?? ctx.customerId;

      const facts = await listFactsForUser(ctx.amEmail).catch(() => []);
      const styleBlock = renderFactsForPrompt(facts);

      const snapshot = buildCustomerSnapshot(customer);
      const amDisplayName = ctx.amName ?? "the AM";

      const system = `You are Beacon AI drafting an INTERNAL SLACK message for an account manager to post to their team. Conventions:
- Lowercase. No formal greetings ("Hi team,") and no formal closings.
- Terse — Slack messages are scannable, not letters. Aim for 1-3 short sentences unless the brief explicitly needs more.
- It's internal, not customer-facing. Use Zoca-internal vocabulary (bizname, RED/YELLOW/GREEN, AM names, ticket ids) where it helps.
- Reference 1 specific data point from CUSTOMER CONTEXT so the message is concrete, not vague.
- Plain text. No Markdown headers, no fenced code. Inline backticks for ids/handles are fine.
- Match the AM's working style if provided.

OUTPUT FORMAT — output exactly this JSON, nothing else, no fences:
{"message":"..."}

Use \\n for line breaks if you need multiple lines.`;

      const userPrompt = `WORKING STYLE for ${amDisplayName}:
${styleBlock ?? "(no style preferences captured yet — default to terse + direct)"}

CUSTOMER CONTEXT:
${snapshot}

INTENDED CHANNEL: ${channelHint ?? "(not specified — write as a generic internal heads-up)"}

BODY BRIEF (what the AM wants this message to convey):
${bodyBrief}

Draft the Slack message now. JSON only.`;

      const res = await anthropic.messages.create({
        model: DRAFT_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: userPrompt }],
      });

      const text = res.content
        .filter((b): b is { type: "text"; text: string; citations?: unknown[] } =>
          b.type === "text",
        )
        .map((b) => b.text)
        .join("");

      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end < 0 || end <= start) {
        return {
          ok: false,
          error: "Couldn't parse Haiku's draft output — no JSON object found.",
        };
      }
      let parsed: { message?: unknown };
      try {
        parsed = JSON.parse(text.slice(start, end + 1)) as { message?: unknown };
      } catch (e) {
        return {
          ok: false,
          error: `Draft JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const message =
        typeof parsed.message === "string" && parsed.message.trim()
          ? parsed.message.trim()
          : null;
      if (!message) {
        return { ok: false, error: "Draft message came back empty." };
      }

      const summary = `Drafted Slack message about ${customerLabel}${channelHint ? ` for ${channelHint}` : ""}.`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:draft_slack_message",
        surface: "customer-360",
        entity_id: ctx.customerId,
        metadata: {
          source: "beacon_ai",
          tool: "draft_slack_message",
          channel_hint: channelHint,
          message_chars: message.length,
          model: DRAFT_MODEL,
          bizname: customer?.company ?? ctx.customerName,
        },
      });

      return {
        ok: true,
        summary,
        data: {
          message,
          channel_hint: channelHint,
          bizname: customer?.company ?? ctx.customerName ?? null,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:draft_slack_message:error",
        surface: "customer-360",
        entity_id: ctx.customerId,
        metadata: { source: "beacon_ai", error: msg },
      });
      return { ok: false, error: msg };
    }
  },
};
