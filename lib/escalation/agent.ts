// The agent core: one Anthropic call that returns a structured AgentResult.
//
// Why one call instead of a chain?
//   - Keeps Vercel serverless latency bounded (single round-trip to Anthropic).
//   - The model has all the context up front, so triage/draft/summary stay
//     internally consistent (e.g. severity matches the tone of the draft).
//
// We use Anthropic's `tools` parameter to force the response into a known
// JSON shape. The model "calls" a tool named `report` and we parse its input.

import Anthropic from "@anthropic-ai/sdk";
import type { AgentResult, CustomerContext, EscalationInput } from "./types";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

// Defensive accessor: copy-pasting into Vercel often picks up whitespace or
// wraps the value in quotes, which Anthropic then rejects with 401.
export function getAnthropicApiKey(): { key: string; sanitized: boolean; raw: string | undefined } {
  const raw = process.env.ANTHROPIC_API_KEY;
  let key = raw || "";
  const before = key;
  key = key.replace(/^['"\s]+|['"\s]+$/g, "");
  return { key, sanitized: key !== before, raw };
}

export function describeKeyProblem(key: string): string | null {
  if (!key) {
    return "ANTHROPIC_API_KEY is empty. Add it in Vercel → Settings → Environment Variables → Production, then redeploy.";
  }
  if (!/^sk-ant-/.test(key)) {
    return `ANTHROPIC_API_KEY doesn't look like an Anthropic key (real ones start with "sk-ant-"). Yours starts with "${key.slice(0, 8)}…". Generate a fresh one at https://console.anthropic.com/settings/keys.`;
  }
  return null;
}

function buildContextPrompt(ctx: CustomerContext): string {
  const c = ctx.customer;
  const lines: string[] = [];
  lines.push("CUSTOMER");
  lines.push(`  biz_name: ${c.bizName ?? "(unknown)"}`);
  lines.push(`  customer_id: ${c.customerId ?? "(unknown)"}`);
  lines.push(`  entity_id: ${c.entityId ?? "(unknown)"}`);
  lines.push(`  contact: ${[c.firstName, c.lastName].filter(Boolean).join(" ") || "(unknown)"} <${c.email ?? ""}>`);
  lines.push(`  phone: ${c.phone ?? "(unknown)"}`);
  lines.push(`  AM: ${c.amName ?? "(none)"} | SP: ${c.spName ?? "(none)"} | AE: ${c.aeName ?? "(none)"}`);
  lines.push(`  status: ${c.status ?? "(unknown)"}`);
  if (c.churnDate) lines.push(`  churn_date: ${c.churnDate}`);
  if (typeof c.totalMonthlyRevenue === "number") lines.push(`  monthly_revenue: $${c.totalMonthlyRevenue.toFixed(2)}`);

  if (ctx.subscription) {
    lines.push("");
    lines.push("SUBSCRIPTION");
    lines.push(`  status: ${ctx.subscription.status ?? "(unknown)"}`);
    if (ctx.subscription.cancellingAt) lines.push(`  cancelling_at: ${ctx.subscription.cancellingAt}`);
    lines.push(`  auto_collection: ${ctx.subscription.autoCollection ?? "(unknown)"}`);
    if (ctx.subscription.planId) lines.push(`  plan: ${ctx.subscription.planId}`);
    if (typeof ctx.subscription.mrr === "number") lines.push(`  mrr: $${ctx.subscription.mrr.toFixed(2)}`);
  }

  if (ctx.unpaidInvoices.length) {
    lines.push("");
    lines.push("UNPAID INVOICES");
    for (const inv of ctx.unpaidInvoices) {
      lines.push(`  - ${inv.invoiceId} | ${inv.status} | $${inv.amountDue.toFixed(2)} | dated ${inv.date}${inv.ach === "in_progress" ? " | ACH in progress" : ""}`);
    }
  }

  if (ctx.signals.length) {
    lines.push("");
    lines.push("SIGNALS");
    for (const s of ctx.signals) lines.push(`  - ${s}`);
  }

  if (ctx.recentComms.length) {
    lines.push("");
    lines.push("RECENT COMMUNICATIONS (most recent first, last 90 days, capped)");
    // Cap to keep tokens bounded — both message count and per-message length.
    const capped = ctx.recentComms.slice(0, 60);
    const truncBody = (s: string, max = 600) => (s && s.length > max ? s.slice(0, max - 1) + "…" : s || "");
    for (const m of capped) {
      const dur = m.durationSec ? ` (${m.durationSec}s)` : "";
      lines.push(`  [${m.createdAt}] ${m.channel}${dur} ${m.sender}: ${truncBody(m.body)}`);
    }
  } else {
    lines.push("");
    lines.push("RECENT COMMUNICATIONS: (none on file or entity_id unknown)");
  }

  if (ctx.lookupNotes.length) {
    lines.push("");
    lines.push("LOOKUP NOTES");
    for (const n of ctx.lookupNotes) lines.push(`  - ${n}`);
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are an Escalation Handling Agent for Zoca, a beauty & wellness software platform. An "escalation" is any inbound message — from any channel (Slack, email, SMS, app chat, phone-call note, video-call note, web form, webhook) — that needs human attention.

For each escalation you receive you MUST do four things:

1) TRIAGE — assign severity (P0..P3) and a category.
   - P0: revenue at risk now, churn imminent, public/legal threat, payment-blocking outage.
   - P1: angry customer, billing dispute, repeated unanswered ask, paid feature broken.
   - P2: standard support — bug, how-to, account question, data fix.
   - P3: feature request, casual question, FYI, nice-to-have.
2) ROUTE — recommend the right owner. Prefer the named AM from the customer record when present. Otherwise pick a role (Support / Billing / Engineering / CS Lead).
3) SUMMARIZE — 4–6 sentence brief for the owner. Lead with the customer name, the ask, and the relevant history.
4) DRAFT a reply in the customer's likely-preferred channel and tone (informed by the comms history). Use the customer's first name. Be warm, concise, specific. Never invent facts. If you don't know something, say what you'll do to find out and propose a next step.

Also evaluate AUTO-RESOLVE eligibility:
   - Eligible only if the issue is low-risk AND the answer is unambiguous AND the draft doesn't promise anything we can't verify (no refunds, no credits, no roadmap commitments, no SLA promises).
   - Provide confidence in [0,1]. Anything above 0.85 may be auto-sent; below that, route to a human.

Constraints:
   - Never make up customer data, AM names, or invoice numbers. Only cite what's in CONTEXT.
   - If CONTEXT is sparse, say so in the summary and lower auto-resolve confidence.
   - Drafts should be plain text, no markdown.
   - Output via the \`report\` tool. Do not respond in plain text.`;

const REPORT_TOOL: Anthropic.Tool = {
  name: "report",
  description: "Submit the structured escalation report. This is the only allowed output channel.",
  input_schema: {
    type: "object",
    properties: {
      severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
      category: {
        type: "string",
        enum: [
          "billing",
          "product_bug",
          "feature_request",
          "onboarding",
          "churn_risk",
          "data_question",
          "complaint",
          "general",
          "other",
        ],
      },
      ownerSuggestion: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["AM", "Support", "Engineering", "Billing", "CS Lead"] },
          namedPerson: { type: "string", description: "Person from CONTEXT, e.g. AM name. Omit if not in CONTEXT." },
          rationale: { type: "string" },
        },
        required: ["role", "rationale"],
      },
      summary: { type: "string", description: "4-6 sentence brief for the owner." },
      draftReply: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            enum: ["app_chat", "email", "phone", "video", "sms", "best_match"],
          },
          subject: { type: "string", description: "Email subject if channel is email; otherwise omit." },
          body: { type: "string" },
        },
        required: ["channel", "body"],
      },
      autoResolvable: {
        type: "object",
        properties: {
          eligible: { type: "boolean" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
        },
        required: ["eligible", "confidence", "reason"],
      },
      routing: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    type: { const: "slack_dm" },
                    to: { type: "string" },
                    message: { type: "string" },
                  },
                  required: ["type", "to", "message"],
                },
                {
                  type: "object",
                  properties: {
                    type: { const: "slack_channel" },
                    channel: { type: "string" },
                    message: { type: "string" },
                  },
                  required: ["type", "channel", "message"],
                },
                {
                  type: "object",
                  properties: {
                    type: { const: "linear_issue" },
                    team: { type: "string" },
                    title: { type: "string" },
                    body: { type: "string" },
                    labels: { type: "array", items: { type: "string" } },
                  },
                  required: ["type", "title", "body"],
                },
                {
                  type: "object",
                  properties: {
                    type: { const: "email" },
                    to: { type: "string" },
                    subject: { type: "string" },
                    body: { type: "string" },
                  },
                  required: ["type", "to", "subject", "body"],
                },
                {
                  type: "object",
                  properties: {
                    type: { const: "noop" },
                    reason: { type: "string" },
                  },
                  required: ["type", "reason"],
                },
              ],
            },
          },
        },
        required: ["actions"],
      },
      signalsUsed: {
        type: "array",
        items: { type: "string" },
        description: "Echo back which CONTEXT signals you actually used.",
      },
    },
    required: [
      "severity",
      "category",
      "ownerSuggestion",
      "summary",
      "draftReply",
      "autoResolvable",
      "routing",
      "signalsUsed",
    ],
  } as Anthropic.Tool["input_schema"],
};

export async function runAgent(input: EscalationInput, ctx: CustomerContext): Promise<AgentResult> {
  const { key, sanitized } = getAnthropicApiKey();
  const formatProblem = describeKeyProblem(key);
  if (formatProblem) throw new Error(formatProblem);
  const client = new Anthropic({ apiKey: key });
  // If we sanitized whitespace/quotes, the call below should now succeed even
  // if Vercel still has the dirty value; this makes the dashboard self-healing
  // for the most common copy-paste mistake.
  void sanitized;

  const userPrompt = [
    `ESCALATION (received via ${input.source?.medium ?? "unknown"}${input.source?.channelOrThread ? `, ${input.source.channelOrThread}` : ""}):`,
    "----",
    input.text,
    "----",
    "",
    "CONTEXT:",
    buildContextPrompt(ctx),
  ].join("\n");

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: [REPORT_TOOL],
      tool_choice: { type: "tool", name: "report" },
      messages: [{ role: "user", content: userPrompt }],
    });
  } catch (err: any) {
    // Convert Anthropic SDK errors into clearer, action-oriented messages.
    const status = err?.status || err?.response?.status;
    if (status === 401) {
      const sanitizedNote = sanitized
        ? " (I already stripped whitespace/quotes from your env var, but Anthropic still rejected the key — so the value itself is wrong, not just dirty.)"
        : "";
      throw new Error(
        `Anthropic rejected the API key (401 invalid x-api-key).${sanitizedNote} Generate a fresh key at https://console.anthropic.com/settings/keys, paste it into Vercel → Settings → Environment Variables → Production as ANTHROPIC_API_KEY (no quotes, no spaces), then click Redeploy on the latest deployment. Hit /api/health to verify before retrying.`
      );
    }
    if (status === 402 || /credit|billing|insufficient/i.test(err?.message || "")) {
      throw new Error(
        "Anthropic API credit issue. Top up at https://console.anthropic.com/settings/billing, then retry."
      );
    }
    if (status === 429) {
      throw new Error("Anthropic rate-limited the request (429). Wait a moment and retry.");
    }
    throw err;
  }

  // Find the tool_use block.
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "report"
  );
  if (!toolUse) {
    throw new Error("Agent did not return a report tool_use block.");
  }
  const result = toolUse.input as AgentResult;
  return result;
}
