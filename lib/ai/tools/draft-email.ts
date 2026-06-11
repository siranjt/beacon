/**
 * draft_email_to_contact — Beacon AI tool. Phase E-16 Wave 2.
 *
 * Generates an email draft in the AM's voice for a specific customer. The
 * draft is produced inline via Haiku at execute() time — re-drafting is
 * intentional (AM might want a different angle), so this tool is NOT in the
 * idempotent set on the executor endpoint.
 *
 * Recipient resolution:
 *   - If `contact_email` was passed, we use it verbatim and try to find the
 *     matching contact in `customer.hubspot.contacts` for name + title.
 *   - Otherwise we pick the top contact (first row — already sorted by
 *     last_activity desc in Stage D).
 *   - If HubSpot contacts are missing entirely, we fall back to the
 *     ScoredCustomerV2 owner email (`customer.email`).
 *
 * Voice:
 *   - Loads the AM's style/tone/depth facts from beacon_ai_user_facts so
 *     the draft matches how they normally write.
 *   - Pulls 1-2 specific data points about the customer from the snapshot
 *     (composite, reason_one_line, days_since_out, recent ticket count) so
 *     the email doesn't read like a templated check-in.
 *
 * Returns:
 *   { subject, body, recipient_email, recipient_name }
 *
 * ActionCard previews the draft + recipient before approval. On Approve the
 * executor runs Haiku and ships the final text back to the card with Copy +
 * Open-in-Gmail buttons. On Discard we skip Haiku entirely — no cost.
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
const MAX_SUBJECT_BRIEF = 200;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

interface Recipient {
  email: string | null;
  name: string | null;
  job_title: string | null;
}

function pickRecipient(
  c: ScoredCustomerV2 | null,
  requested: string | null,
): Recipient {
  if (!c) {
    return { email: requested, name: null, job_title: null };
  }
  const contacts = c.hubspot?.contacts ?? [];
  if (requested && contacts.length > 0) {
    const hit = contacts.find(
      (k) => (k.email ?? "").toLowerCase() === requested.toLowerCase(),
    );
    if (hit) {
      return { email: hit.email, name: hit.name ?? null, job_title: hit.job_title };
    }
    return { email: requested, name: null, job_title: null };
  }
  if (contacts.length > 0) {
    // Stage D already sorts top contacts by last_activity; take the first.
    const top = contacts[0];
    return { email: top.email, name: top.name ?? null, job_title: top.job_title };
  }
  return {
    email: requested ?? c.email ?? null,
    name: null,
    job_title: null,
  };
}

function buildCustomerSnapshot(c: ScoredCustomerV2 | null): string {
  if (!c) return "(no customer data on file)";
  const lines: string[] = [];
  if (c.company) lines.push(`Business: ${c.company}`);
  if (c.am_name) lines.push(`AM on record: ${c.am_name}`);
  const s = c.signals_v2;
  if (s) {
    lines.push(
      `Current health: composite ${s.composite} (${s.stoplight ?? "?"}), tier ${s.tier ?? "?"}, trajectory ${s.trajectory_7d ?? "unknown"}`,
    );
    if (s.reason_one_line) lines.push(`Why we're watching: ${s.reason_one_line}`);
    if (s.suggested_action) lines.push(`Suggested next: ${s.suggested_action}`);
  }
  const m = c.metrics;
  if (m) {
    if (typeof m.days_since_out === "number")
      lines.push(`Days since our last outbound: ${m.days_since_out}`);
    if (typeof m.days_since_in === "number")
      lines.push(`Days since their last inbound: ${m.days_since_in}`);
  }
  const t = c.tickets;
  if (t && (t.open_count ?? t.open_tickets_30d ?? 0) > 0) {
    lines.push(
      `Open tickets: ${t.open_count ?? t.open_tickets_30d}${t.oldest_open_age_days ? ` (oldest ${t.oldest_open_age_days}d)` : ""}`,
    );
  }
  return lines.join("\n");
}

export const draftEmailToContactTool: BeaconTool = {
  name: "draft_email_to_contact",
  description:
    "Draft a customer-facing email in the AM's voice. Picks the top HubSpot contact by default; pass `contact_email` to target a specific recipient. `body_brief` (required, 1-3 sentences) tells Beam intent + tone + angle. The AM previews and approves; Beam never sends — it stages a draft.\n" +
    "Trigger phrases: \"draft an outreach to Acme\", \"compose an email to the owner\", \"write a check-in to Hannah\", \"send them a follow-up\".",
  input_schema: {
    type: "object",
    properties: {
      customer_id: {
        type: "string",
        description:
          "The entity_id of the customer this email is about. Required. Match against CONTEXT.identity.entity_id, or use lookup_customer first if the customer isn't already in the scope.",
      },
      contact_email: {
        type: "string",
        description:
          "Optional. Specific recipient email if the AM named someone (e.g. 'draft to Hannah'). Otherwise Beacon picks the top contact on the company.",
      },
      subject_brief: {
        type: "string",
        description:
          "Optional. Short hint for the subject line (e.g. 'follow up on last week's check-in'). If omitted, Beacon writes one.",
        maxLength: MAX_SUBJECT_BRIEF,
      },
      body_brief: {
        type: "string",
        description:
          "Required. What the email should convey — intent, tone, the angle. 1-3 short sentences is enough; Beacon expands into a full email. Example: 'Warm check-in. Their score moved up. Mention the GBP click trend. Ask if they want to do a quarterly review call.'",
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
    const subjectBrief =
      typeof args.subject_brief === "string"
        ? args.subject_brief.trim().slice(0, MAX_SUBJECT_BRIEF)
        : null;
    const contactEmailRaw =
      typeof args.contact_email === "string" ? args.contact_email.trim() : null;

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
      const recipient = pickRecipient(customer, contactEmailRaw);

      if (!recipient.email) {
        return {
          ok: false,
          error:
            "Couldn't find a recipient email — this customer has no HubSpot contacts and no owner email on record. Add a contact in HubSpot or pass `contact_email` explicitly.",
        };
      }

      // Load the AM's style/tone/depth facts so the draft matches their voice.
      const facts = await listFactsForUser(ctx.amEmail).catch(() => []);
      const styleBlock = renderFactsForPrompt(facts);

      const snapshot = buildCustomerSnapshot(customer);
      const customerLabel = customer?.company ?? ctx.customerName ?? ctx.customerId;
      const amDisplayName = ctx.amName ?? "the account manager";
      const recipientName = recipient.name ?? "the owner";

      const system = `You are Beacon AI drafting an email FOR an account manager. Output two parts: a short subject line and a body. Constraints:
- Write in the AM's voice (see WORKING STYLE below). Match warmth, length, formality.
- Use the recipient's first name where possible ("Hi Hannah,") — but skip the greeting if the AM's style says terse.
- Reference 1-2 specific data points from CUSTOMER CONTEXT so the email feels personal, not templated. Don't quote raw numbers if they'd confuse the customer — translate them ("your visibility is up again" not "your composite improved to 42").
- NO Markdown. Plain text only.
- NO signoff or signature — the AM has their own.
- Keep it under 150 words for body unless the brief says otherwise.

OUTPUT FORMAT — output exactly this JSON, nothing else, no fences:
{"subject":"...","body":"..."}

The body should be readable plain text with \\n for line breaks between paragraphs.`;

      const userPrompt = `WORKING STYLE for ${amDisplayName}:
${styleBlock ?? "(no style preferences captured yet — default to warm-but-direct, AM-friendly)"}

CUSTOMER CONTEXT:
${snapshot}

RECIPIENT: ${recipientName}${recipient.job_title ? ` (${recipient.job_title})` : ""} at ${customerLabel} — ${recipient.email}

SUBJECT HINT: ${subjectBrief ?? "(none — write your own short subject)"}

BODY BRIEF (what the AM wants this email to convey):
${bodyBrief}

Draft the email now. JSON only.`;

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

      // Lenient JSON extraction — Haiku is reliable but defend against
      // leading prose or wrapped code fences anyway.
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end < 0 || end <= start) {
        return {
          ok: false,
          error: "Couldn't parse Haiku's draft output — no JSON object found.",
        };
      }
      let parsed: { subject?: unknown; body?: unknown };
      try {
        parsed = JSON.parse(text.slice(start, end + 1)) as {
          subject?: unknown;
          body?: unknown;
        };
      } catch (e) {
        return {
          ok: false,
          error: `Draft JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const subject =
        typeof parsed.subject === "string" && parsed.subject.trim()
          ? parsed.subject.trim().slice(0, 300)
          : `Quick note from ${amDisplayName}`;
      const body =
        typeof parsed.body === "string" && parsed.body.trim()
          ? parsed.body.trim()
          : null;
      if (!body) {
        return { ok: false, error: "Draft body came back empty." };
      }

      const summary = `Drafted email to ${recipientName} at ${customerLabel} — "${subject.slice(0, 60)}".`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:draft_email_to_contact",
        surface: "customer-360",
        entity_id: ctx.customerId,
        metadata: {
          source: "beacon_ai",
          tool: "draft_email_to_contact",
          recipient_email: recipient.email,
          recipient_name: recipient.name,
          subject_chars: subject.length,
          body_chars: body.length,
          model: DRAFT_MODEL,
          bizname: customer?.company ?? ctx.customerName,
        },
      });

      return {
        ok: true,
        summary,
        data: {
          subject,
          body,
          recipient_email: recipient.email,
          recipient_name: recipient.name,
          recipient_job_title: recipient.job_title,
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
        event_name: "beacon_ai:action:draft_email_to_contact:error",
        surface: "customer-360",
        entity_id: ctx.customerId,
        metadata: { source: "beacon_ai", error: msg },
      });
      return { ok: false, error: msg };
    }
  },
};
