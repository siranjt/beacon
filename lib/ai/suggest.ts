/**
 * Beacon AI proactive suggestions. Phase E-9.
 *
 * Returns 2-3 contextual "next best actions" for a given scope (currently
 * Customer 360 only). Calls Haiku with the customer's full data context +
 * the user's distilled facts, asks for structured JSON with action cards.
 *
 * No mutations in v1 — only soft actions:
 *   - `ask`      → open AskPanel pre-filled with a specific question
 *   - `draft`    → open AskPanel pre-filled with a draft request
 *   - `navigate` → deep-link to another surface (performance / escalation / Linear)
 *
 * Mutation actions (mark contacted, snooze, etc.) come in a later phase
 * once we've designed undo / confirm / side-effect handling properly.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AiScope } from "./scopes";
import { loadCustomer360Context, type LoadedContext } from "./context-loaders";
import { listFactsForUser, renderFactsForPrompt } from "./facts";

const MODEL = process.env.ANTHROPIC_SUGGEST_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1500;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

export type ActionKind = "ask" | "draft" | "navigate";

export interface SuggestedAction {
  kind: ActionKind;
  label: string;        // "Draft a check-in email"
  why: string;          // "Last outbound was 38 days ago"
  /** For ask + draft — the prompt to send to AskPanel. */
  prompt?: string;
  /** For navigate — the URL to open. */
  href?: string;
}

export interface SuggestResult {
  scope: AiScope;
  audience: string;
  actions: SuggestedAction[];
  generated_at: string;
}

const SUGGEST_SYSTEM = `You are Beacon AI's proactive recommendation engine. Your job is to look at a single customer's full data picture and propose 2-3 specific, high-leverage next actions an account manager could take RIGHT NOW.

You always output a JSON array of action objects. Each action has:
{
  "kind": "ask" | "draft" | "navigate",
  "label": "<8 words or less, imperative — 'Draft a check-in email'>",
  "why": "<one short sentence citing specific data — 'Last outbound was 38 days ago'>",
  "prompt": "<for ask/draft only — the exact question/request to seed into the AskPanel>",
  "href": "<for navigate only — e.g. /performance/report/{entity_id} or a Linear url>"
}

ACTION KINDS:
- "ask"     → user clicks, AskPanel opens, the prompt is pre-typed. Good for "Why is this RED?" or "Compare their billing trajectory to last month."
- "draft"   → AskPanel opens, prompt asks Beacon AI to draft something (email, slack message). The prompt should specify the format and reference one specific data point.
- "navigate" → deep-link to another surface. Only use when navigating helps more than asking. e.g. open the Performance Beacon report, jump to an open Linear ticket.

RULES:
- 2-3 actions only. Never 1. Never 4+.
- Each action must reference SPECIFIC data from the context (a number, a date, a name).
- Prioritize the highest-leverage action FIRST. If composite is RED, action #1 should address that.
- Don't suggest "mark contacted" or any mutation — only ask/draft/navigate are allowed in v1.
- Don't propose generic actions ("review the customer's data") — be concrete.
- Reference the user's stored facts (USER PROFILE) to match their preferred response style and topic focus.
- If there's an open Linear ticket older than 14 days, propose a navigate to it.
- If GBP clicks dropped >25% vs peak, propose an ask about why.
- If the AM hasn't talked to this customer in 14+ days, propose a draft outreach.
- Output ONLY the JSON array — no preamble, no markdown fences, no trailing text.`;

interface RawAction {
  kind?: string;
  label?: string;
  why?: string;
  prompt?: string;
  href?: string;
}

/** Tries to extract a JSON array from a possibly-noisy LLM response. */
function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isValidAction(a: unknown): a is RawAction {
  if (!a || typeof a !== "object") return false;
  const obj = a as RawAction;
  if (typeof obj.kind !== "string") return false;
  if (!["ask", "draft", "navigate"].includes(obj.kind)) return false;
  if (typeof obj.label !== "string" || !obj.label.trim()) return false;
  if (typeof obj.why !== "string" || !obj.why.trim()) return false;
  if (obj.kind === "navigate" && typeof obj.href !== "string") return false;
  if ((obj.kind === "ask" || obj.kind === "draft") && typeof obj.prompt !== "string") return false;
  return true;
}

/** Sanitize navigate hrefs — only allow internal Beacon paths or
 *  https://linear.app links. Anything else gets rewritten to a search. */
function sanitizeHref(href: string, entityId: string | null): string {
  const trimmed = href.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }
  if (trimmed.startsWith("https://linear.app/")) {
    return trimmed;
  }
  // Fallback — point at the Customer 360 if we have one, otherwise launcher.
  return entityId ? `/360/${entityId}` : "/";
}

export async function suggestForScope(
  scope: AiScope,
  email: string,
): Promise<SuggestResult> {
  // v1 — only customer-360 scope is supported. Other scopes return an
  // empty actions array; the client renders nothing in that case.
  if (scope.kind !== "customer-360") {
    return {
      scope,
      audience: "(unsupported scope)",
      actions: [],
      generated_at: new Date().toISOString(),
    };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      scope,
      audience: "(no api key)",
      actions: [],
      generated_at: new Date().toISOString(),
    };
  }

  let ctx: LoadedContext;
  try {
    ctx = await loadCustomer360Context(scope.entityId);
  } catch {
    return {
      scope,
      audience: scope.entityId,
      actions: [],
      generated_at: new Date().toISOString(),
    };
  }

  const facts = await listFactsForUser(email).catch(() => []);
  const profile = renderFactsForPrompt(facts);

  const userPrompt = [
    profile ? `## USER PROFILE\n${profile}\n` : "",
    `## CUSTOMER CONTEXT\n${ctx.blob}`,
    "",
    "Return the JSON array of 2-3 actions now.",
  ].join("\n");

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SUGGEST_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");

    const arr = extractJsonArray(text);
    if (!arr) {
      return {
        scope,
        audience: ctx.audience,
        actions: [],
        generated_at: new Date().toISOString(),
      };
    }

    const actions: SuggestedAction[] = arr
      .filter(isValidAction)
      .map((a) => {
        const kind = a.kind as ActionKind;
        return {
          kind,
          label: a.label!.trim().slice(0, 80),
          why: a.why!.trim().slice(0, 200),
          prompt:
            kind === "ask" || kind === "draft"
              ? a.prompt!.trim().slice(0, 1500)
              : undefined,
          href:
            kind === "navigate"
              ? sanitizeHref(a.href!, scope.entityId)
              : undefined,
        };
      })
      .slice(0, 3);

    return {
      scope,
      audience: ctx.audience,
      actions,
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    // Silent fallback — the UI just renders nothing.
    console.warn(
      "[ai/suggest] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return {
      scope,
      audience: ctx.audience,
      actions: [],
      generated_at: new Date().toISOString(),
    };
  }
}
