/**
 * Beacon AI proactive suggestions. Phase E-9.
 *
 * Returns 2-3 contextual "next best actions" for the current scope. Calls
 * Haiku with scope-appropriate context + the user's distilled facts, asks
 * for structured JSON action cards.
 *
 * Supported scopes:
 *   - inbox                  → "what should I tackle today" actions
 *   - customer-360           → per-customer triage actions
 *   - customer-book          → AM book-level patterns + outreach drafts
 *   - performance-landing    → meta / conceptual asks (Beam knowledge)
 *   - performance-report     → single-customer performance actions
 *   - escalation-overview    → queue triage + stalled-ticket nudges
 *   - post-payment-book      → verdict-feed summaries + AM-call queue
 *   - post-payment-customer  → walk-through-this-verdict actions
 *
 * No mutations in v1 — only soft actions:
 *   - `ask`      → open AskPanel pre-filled with a specific question
 *   - `draft`    → open AskPanel pre-filled with a draft request, auto-submitted
 *   - `navigate` → deep-link to another surface (any internal Beacon path or
 *                  https://linear.app/* url)
 *
 * Mutation actions (mark contacted, snooze, etc.) come in a later phase
 * once we've designed undo / confirm / side-effect handling properly.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AiScope } from "./scopes";
import {
  loadCustomer360Context,
  loadCustomerBookContext,
  loadEscalationOverviewContext,
  loadInboxContext,
  loadMissPaymentOverviewContext,
  loadNegativeKeywordOverviewContext,
  loadPerformanceLandingContext,
  loadPerformanceReportContext,
  loadPostPaymentBookContext,
  loadPostPaymentCustomerContext,
  type LoadedContext,
} from "./context-loaders";
import { listFactsForUser, renderFactsForPrompt } from "./facts";
import { getRoleForEmail } from "@/lib/customer/config";
import { getCachedContext, makeCacheKey } from "./context-cache";
import { todaySnapshotDate } from "@/lib/customer/pipeline-state";
// META-A5 — log spend for every suggest call.
import { logSpend, extractUsage } from "./spend-log";

const MODEL = process.env.ANTHROPIC_SUGGEST_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1500;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

export type ActionKind = "ask" | "draft" | "navigate";

export interface SuggestedAction {
  kind: ActionKind;
  label: string;
  why: string;
  prompt?: string;
  href?: string;
}

export interface SuggestResult {
  scope: AiScope;
  audience: string;
  actions: SuggestedAction[];
  generated_at: string;
}

/* ────────────────────────────────────────────────────────────────
 * Prompt assembly — base rules shared across scopes; per-scope
 * guidance appended on top.
 * ──────────────────────────────────────────────────────────────── */

const BASE_RULES = `You are Beam's proactive recommendation engine. Your job is to read the user's current surface + data context and propose 2-3 specific, high-leverage next actions they could take RIGHT NOW.

Output a JSON array of action objects, no preamble, no markdown fences:
[
  {
    "kind": "ask" | "draft" | "navigate",
    "label": "<8 words or less, imperative — 'Draft a check-in email'>",
    "why": "<one short sentence citing specific data — 'Last outbound was 38 days ago'>",
    "prompt": "<for ask/draft only — the exact question/request to seed into the AskPanel>",
    "href": "<for navigate only — e.g. /360/{entity_id}, /performance/report/{entity_id}, /escalation?q={biz}, https://linear.app/...>"
  }
]

ACTION KINDS:
- "ask"     → user clicks, AskPanel opens, prompt is pre-typed for the user to review/edit. Good for "Why is this RED?" or "Compare their billing trajectory."
- "draft"   → AskPanel opens, prompt is pre-typed AND auto-submitted. Beam starts streaming immediately. Use ONLY for deliverables (emails, slack messages, summaries) that don't need user editing first.
- "navigate" → deep-link to another surface. Only use when navigating helps more than asking.

RULES:
- 2-3 actions only. Never 1. Never 4+.
- Each action must reference SPECIFIC data from the context (a number, a date, a bizname).
- Prioritize the highest-leverage action FIRST.
- Don't suggest mutations ("mark contacted", "snooze") — only ask/draft/navigate are allowed.
- Don't propose generic actions ("review the data") — be concrete.
- Respect the USER PROFILE: match their preferred response style and topic focus.`;

function scopeGuidance(scope: AiScope): string {
  switch (scope.kind) {
    case "inbox":
      return `SCOPE: User is on today's inbox — a cross-agent feed of customers needing contact, post-payment verdicts awaiting action, and open tickets.

Good suggestions:
- ASK about the single highest-leverage item today
- DRAFT outreach to the most-silent RED customer
- NAVIGATE to a specific 360 page for a customer that needs deep attention
Use entity IDs you find in the context for navigate hrefs: /360/{entity_id}.`;

    case "customer-360":
      return `SCOPE: User is looking at one customer's full 360 view.

Good suggestions:
- ASK why composite is at its level / what the dominant signal is
- DRAFT a check-in email referencing one specific data point (silence days, billing event, ticket)
- NAVIGATE to the Performance Beacon report (/performance/report/{entity_id}) or an open Linear ticket
If there's an open Linear ticket older than 14 days, prefer navigating to it.
If GBP clicks dropped >25% vs peak, propose an ASK about why.
If last_out is >14 days, propose a DRAFT outreach.`;

    case "customer-book":
      return `SCOPE: User is on the Customer Beacon dashboard looking at their book.

Good suggestions:
- ASK about patterns across RED customers in their book ("what's the dominant signal?")
- ASK who's regressing fastest in their book
- DRAFT a book health summary they can share with their manager
- NAVIGATE to the 360 of their worst-trajectory customer
For navigate, pick a real entity_id from the context.`;

    case "performance-landing":
      return `SCOPE: User is on Performance Beacon landing, no specific customer picked.

Good suggestions:
- ASK conceptual questions ("how is composite calculated", "what's a healthy GBP click trend")
- NAVIGATE to a recent report URL if the context shows one (else skip navigate)
Most useful actions here are ASKs that explain Beacon's product mechanics.`;

    case "performance-report":
      return `SCOPE: User is reading one customer's Performance Beacon report.

Good suggestions:
- ASK whether YTD leads are on track vs the predicted 6-month figure
- ASK about the biggest concern in this report
- DRAFT a check-in message highlighting one win + one focus area
- NAVIGATE to the customer's 360 page (/360/{entity_id}) for full context`;

    case "escalation-overview":
      return `SCOPE: User is on Escalation Beacon looking at the open ticket queue.

Good suggestions:
- ASK how to prioritize the queue
- ASK about stalled tickets (older than 14 days)
- ASK about ticket patterns this week
- NAVIGATE to a specific Linear ticket URL from the open_sample if one is notably old or critical (use the t.url field)`;

    case "post-payment-book":
      return `SCOPE: User is on Post-Payment Reviews dashboard looking at recent verdicts.

Good suggestions:
- ASK to summarize the week's verdicts
- ASK who needs AM follow-up (verdict in Review/Not ICP + needs_am_call=true)
- ASK about common reasons for Not ICP verdicts
- NAVIGATE to the most concerning recent verdict (/post-payment/reports/{cb_customer_id})`;

    case "post-payment-customer":
      return `SCOPE: User is reading one customer's Post-Payment Review.

Good suggestions:
- ASK to walk through the verdict ("why did this land as X?")
- ASK if there's a case to push back on the verdict
- DRAFT a reply to the customer's owner addressing the key concern
- NAVIGATE to the docx report or the customer's 360 page (/360/...)`;

    case "miss-payment-overview":
      return `SCOPE: User is on the Miss Payment Beacon — the unpaid-invoice tracker. Rows pulled live from Chargebee, enriched with BaseSheet AM mapping + active Linear tickets.

Good suggestions:
- ASK which AMs have the highest outstanding balance or the most invoices
- ASK to surface multi-month repeat offenders (entities with unpaid invoices spanning 2+ months)
- ASK about auto-debit Off accounts with large balances
- DRAFT a chase email or Slack message for a specific high-priority customer the user names`;

    case "negative-keyword-overview":
      return `SCOPE: User is on the Negative Keyword Beacon — AI-classified churn-risk alerts queue. Each row is a customer message Haiku flagged as a genuine negative signal, with a 2-sentence analysis.

Good suggestions:
- ASK which customers are the highest churn risk right now (severity-ranked from top_open_alerts)
- ASK which categories are spiking this week (cancellation surge? billing crisis?)
- ASK which AMs have the heaviest open-alert load (from by_am_top_10)
- DRAFT outreach to a specific top-severity customer the user names (use their actual message as context)`;

    case "hidden":
      return "";
  }
}

interface RawAction {
  kind?: string;
  label?: string;
  why?: string;
  prompt?: string;
  href?: string;
}

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

/** Sanitize navigate hrefs — allow any internal Beacon path or
 *  https://linear.app links. Anything else becomes the launcher. */
function sanitizeHref(href: string): string {
  const trimmed = href.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }
  if (trimmed.startsWith("https://linear.app/")) {
    return trimmed;
  }
  return "/";
}

/** Load the right context object for a scope. Mirrors the dispatcher in
 *  /api/ai/ask, kept separate here to avoid circular deps. */
async function loadContextFor(
  scope: AiScope,
  user: { am_name: string | null; role: "admin" | "manager" | "am" | null },
): Promise<LoadedContext | null> {
  switch (scope.kind) {
    case "inbox":
      return loadInboxContext({ amFilter: user.role === "am" ? user.am_name : null });
    case "customer-360":
      return loadCustomer360Context(scope.entityId);
    case "customer-book":
      return loadCustomerBookContext({ amFilter: user.role === "am" ? user.am_name : null });
    case "performance-landing":
      return loadPerformanceLandingContext();
    case "performance-report":
      return loadPerformanceReportContext(scope.entityId);
    case "escalation-overview":
      return loadEscalationOverviewContext();
    case "post-payment-book":
      return loadPostPaymentBookContext();
    case "post-payment-customer":
      return loadPostPaymentCustomerContext(scope.cbCustomerId);
    case "miss-payment-overview":
      // Phase F-polish-AI — real loader; proactive suggestions now fire
      // from live unpaid-invoice aggregates instead of a generic blob.
      return loadMissPaymentOverviewContext();
    case "negative-keyword-overview":
      return loadNegativeKeywordOverviewContext({
        amFilter: user.role === "am" ? user.am_name : null,
      });
    case "hidden":
      return null;
  }
}

/**
 * OPT-5 — TTL cache window. 30min is short enough that fresh context lands
 * within a single AM session but long enough to absorb the page-mount thrash
 * the audit found (10 surfaces, every nav triggers SuggestedActions →
 * /api/ai/suggest → Haiku). Stage A invalidates the "suggest" prefix when a
 * new snapshot lands so we don't serve yesterday's recommendations.
 */
const SUGGEST_CACHE_TTL_MS = 30 * 60 * 1000;

/** Stable key prefix used by invalidatePrefix("suggest") from refresh.ts. */
export const SUGGEST_CACHE_PREFIX = "suggest";

function scopeIdentity(scope: AiScope): { entity_id?: string; cb_customer_id?: string; am_filter?: string } {
  switch (scope.kind) {
    case "customer-360":
    case "performance-report":
      return { entity_id: scope.entityId };
    case "post-payment-customer":
      return { cb_customer_id: scope.cbCustomerId };
    default:
      return {};
  }
}

export async function suggestForScope(
  scope: AiScope,
  email: string,
  sessionAmName: string | null = null,
  opts: { bypassCache?: boolean } = {},
): Promise<SuggestResult> {
  if (scope.kind === "hidden") {
    return {
      scope,
      audience: "",
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

  const role = getRoleForEmail(email);

  // OPT-5 — server-side memoization keyed on (scope-kind, identity, email,
  // role, snapshot_date). Role is included because AM-filtered scopes
  // (inbox/customer-book) load different blobs based on the caller's role.
  // Snapshot date is included so a new daily snapshot naturally rotates the
  // key without needing to wait out the TTL. The explicit invalidatePrefix
  // call from Stage A is the belt over this suspenders.
  const cacheKey = makeCacheKey(SUGGEST_CACHE_PREFIX, {
    scope: scope.kind,
    email,
    role: role ?? "anon",
    am: role === "am" ? sessionAmName ?? "" : "",
    snapshot_date: todaySnapshotDate(),
    ...scopeIdentity(scope),
  });

  try {
    return await getCachedContext(
      cacheKey,
      () => computeSuggestion(scope, email, sessionAmName, role),
      { ttlMs: SUGGEST_CACHE_TTL_MS, bypassCache: opts.bypassCache },
    );
  } catch (e) {
    // OPT-5 — soft-fail: if the cache primitive somehow misbehaves, fall
    // through to a live call so the user still sees suggestions. The cache
    // is best-effort; correctness comes first.
    console.warn(
      "[ai/suggest] cache wrapper failed, falling back to live call:",
      e instanceof Error ? e.message : String(e),
    );
    return computeSuggestion(scope, email, sessionAmName, role);
  }
}

async function computeSuggestion(
  scope: AiScope,
  email: string,
  sessionAmName: string | null,
  role: "admin" | "manager" | "am" | null,
): Promise<SuggestResult> {
  const ctx = await loadContextFor(scope, { am_name: sessionAmName, role }).catch(
    () => null,
  );
  if (!ctx) {
    return {
      scope,
      audience: "(no context)",
      actions: [],
      generated_at: new Date().toISOString(),
    };
  }

  const facts = await listFactsForUser(email).catch(() => []);
  const profile = renderFactsForPrompt(facts);

  const systemPrompt = `${BASE_RULES}\n\n${scopeGuidance(scope)}`;
  const userPrompt = [
    profile ? `## USER PROFILE\n${profile}\n` : "",
    `## CONTEXT (scope: ${scope.kind})\n${ctx.blob}`,
    "",
    "Return the JSON array of 2-3 actions now.",
  ].join("\n");

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    // META-A5 — record this suggest call's spend.
    const usage = extractUsage(res);
    void logSpend({
      feature: "suggest",
      model: MODEL,
      ...usage,
      scope: scope.kind,
      email,
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
          href: kind === "navigate" ? sanitizeHref(a.href!) : undefined,
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
