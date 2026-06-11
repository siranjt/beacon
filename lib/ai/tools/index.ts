/**
 * Beacon AI tool registry. Phase E-16 Wave 1.
 *
 * This is the shared shape every Beacon AI tool exports: a JSON Schema input
 * definition that Anthropic's Claude reads when deciding whether to call the
 * tool, plus a server-side `execute(args, ctx)` handler that performs the
 * actual mutation. The handler ALWAYS writes a row to
 * `am_activity_log` via `logUmbrellaActivity` so we have a full audit trail
 * of every Beacon-proposed action — approved or not.
 *
 * Wave 1 ships four Customer-360 scoped tools:
 *   - snooze_customer
 *   - pin_customer
 *   - mark_contacted_today
 *   - add_note
 *
 * Wave 2 adds three more:
 *   - lookup_customer        (read-only fuzzy search across the book)
 *   - draft_email_to_contact (Haiku-generated email draft in AM voice)
 *   - draft_slack_message    (Haiku-generated internal Slack draft)
 *
 * The two draft tools call Haiku INSIDE execute() — the streaming /api/ai/ask
 * route still uses Sonnet for the conversation. Drafts are NOT idempotent
 * (re-drafting is intentional). lookup_customer has no blast radius so it
 * skips approval entirely (rate-limited + audit-logged as usual).
 *
 * Architecture notes:
 *   - The model proposes; the AM approves. Tool execution does NOT happen
 *     automatically server-side off the streaming endpoint — see
 *     `app/(customer)/api/ai/action/execute/route.ts`.
 *   - Each tool's `execute()` is responsible for its own DB write AND for
 *     emitting the matching activity-log row. That keeps the executor
 *     endpoint thin and forces every tool to be auditable by construction.
 *   - Tool names are stable identifiers — never rename a tool without also
 *     migrating the historical activity-log rows (we key the audit query off
 *     `event_name LIKE 'beacon_ai:action:%'`).
 */

import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";

import type { AiScope } from "@/lib/ai/scopes";

import { snoozeCustomerTool } from "./snooze";
import { pinCustomerTool } from "./pin";
import { markContactedTodayTool } from "./mark-contacted";
import { addNoteTool } from "./add-note";
import { lookupCustomerTool } from "./lookup-customer";
import { draftEmailToContactTool } from "./draft-email";
import { draftSlackMessageTool } from "./draft-slack";
import { queryCustomerBookTool } from "./query-customer-book";
import { readCustomerNotesTool } from "./read-customer-notes";
import { readCustomerBrainTool } from "./read-customer-brain";
import { addFactToBrainTool } from "./add-fact-to-brain";
import { queryBrainTool } from "./query-brain";
import { getChargebeeBillingTool } from "./get-chargebee-billing";
import { getCustomerPerformanceTool } from "./get-customer-performance";
import { getFullCustomerViewTool } from "./get-full-customer-view";
import { getCustomerFromMetabaseTool } from "./get-customer-from-metabase";
import { getBookingHistoryTool } from "./get-booking-history";
import { getMixpanelActivityTool } from "./get-mixpanel-activity";
import { getReviewSummaryTool } from "./get-review-summary";

/**
 * The execution context passed to every tool's `execute()` handler. Filled
 * in by the executor endpoint from the authenticated session + the
 * customer_id in the tool call's input.
 */
export interface ToolExecutionContext {
  /** The AM's email from NextAuth — used for activity logging + rate limit keys. */
  amEmail: string;
  /**
   * The AM's BaseSheet am_name, if any. Used for snooze/pin/mark-contacted/
   * notes writes (those repositories key on am_name, not email). May be null
   * for managers/admins acting outside their own book.
   */
  amName: string | null;
  /** The signed-in user's customer-beacon role. */
  role: "admin" | "manager" | "am" | null;
  /** The customer the tool is acting on. */
  customerId: string;
  /** Display name (biz name) of the customer — used in audit log + summary. */
  customerName: string | null;
  /** Chargebee customer handle for the entity, if known — stored in repos that key on it. */
  cbCustomerId: string | null;
}

/**
 * Tool result shape. Tools never throw — they return `{ok: false, error}`
 * so the executor endpoint can hand the error back to Claude as a
 * tool_result with `is_error: true` and Claude can recover gracefully.
 */
export type ToolResult =
  | { ok: true; summary: string; data?: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Shape every tool module exports. Anthropic's `Tool` type covers the
 * portion we send to the model (name + description + input_schema); the
 * `execute` field is server-only.
 */
export interface BeaconTool {
  /** Stable identifier — must match what Claude returns in `tool_use.name`. */
  name: string;
  /** Long, detailed description — Claude relies on this to choose tools. */
  description: string;
  /** Anthropic JSON Schema (input_schema). */
  input_schema: AnthropicTool.InputSchema;
  /** Server-side handler. Single source of truth for the mutation + audit row. */
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
}

/**
 * Beacon AI tool registry. Originally Wave-1 Customer-360–scoped; Wave 1.5
 * extended these same tools to the multi-customer scopes (customer-book,
 * performance-report, escalation-overview). Wave 2 adds three tools usable
 * from every customer-aware scope: lookup, draft email, draft Slack.
 *
 * Order is meaningful: Claude can see all tools simultaneously, but in the
 * system prompt we suggest the high-frequency mutators first (snooze / pin /
 * mark_contacted / note) so the model reaches for them by default. lookup
 * is a read-only enabling tool and slots in next. Drafts are last because
 * they're heavier (Haiku call inside execute) and only fire on explicit
 * outreach asks.
 *
 * The export name stays `CUSTOMER_360_TOOLS` for backward compatibility
 * with the existing /api/ai/ask import.
 */
export const CUSTOMER_360_TOOLS: BeaconTool[] = [
  snoozeCustomerTool,
  pinCustomerTool,
  markContactedTodayTool,
  addNoteTool,
  lookupCustomerTool,
  draftEmailToContactTool,
  draftSlackMessageTool,
  // Phase F-polish-AI Tier 2 — generalized slice-and-dice over the active
  // book. Read-only, returns structured rows; the model uses the result to
  // compose tabular answers without needing every cross-product
  // pre-computed in CONTEXT.
  queryCustomerBookTool,
  // F-ai-context chunk 2 — read per-customer private AM notes. AM-scoped
  // (own only) or manager-scoped (all AMs' notes) based on the asker's role.
  readCustomerNotesTool,
  // Brain Wave 2a.1 — read per-customer confirmed Brain facts (curated
  // canonical truth). Reachable from any scope; resolves entity_id →
  // customer_id internally. Sister tool to read_customer_notes.
  readCustomerBrainTool,
  // Brain Wave 2a.2 — write a confirmed Brain fact from the AM's
  // conversational input. Confirmation card required; model classifies
  // free-form content into (topic_category, topic_subcategory,
  // field_name, value) using FIELD_CATALOG.
  addFactToBrainTool,
  // Brain Wave 2a.3 — manager cross-book search over Brain facts.
  // Read-only, manager + admin only.
  queryBrainTool,
  // F-ai-context — per-customer billing pull from Chargebee live (customer
  // record, subscriptions, last 20 invoices, last 20 transactions).
  getChargebeeBillingTool,
  // F-ai-context — per-customer performance pull from Metabase Aurora
  // (GBP click trend, keyword rankings, leads, reviews). Mirrors the
  // zoca-performance-report data layer.
  getCustomerPerformanceTool,
  // Cross-scope synthesis — bundles Keeper + comms perspective +
  // performance summary + escalations + notes into one parallel
  // fan-out so "tell me everything about X" lands in a single
  // tool call instead of 4-5 chained read_* hops. Reachable from
  // customer-360 and customer-book scopes.
  getFullCustomerViewTool,
  // META-A1 — Self-healing BaseSheet fallback. When Keeper is empty for
  // a newly-bootstrapped customer, this tool pulls the live BaseSheet
  // row from Metabase, returns the requested fields, AND writes them
  // back to Keeper as confirmed/basesheet facts. Next ask is a Keeper
  // hit — every fallback compounds.
  getCustomerFromMetabaseTool,
  // META-A3 — Live dynamic data tools (read-only, no Keeper write-back
  // because the underlying data changes daily/hourly). All three are
  // single-entity scoped, sliding window, 5-min in-process cached, and
  // soft-fail to clean error strings on Metabase outage so the model
  // can keep going.
  //   - get_booking_history   → website.booking_enquiries (Postgres)
  //   - get_mixpanel_activity → mixpanelzocaappdata.export (Aurora)
  //   - get_review_summary    → reviews.reviews (Aurora)
  getBookingHistoryTool,
  getMixpanelActivityTool,
  getReviewSummaryTool,
];

/** Alias for callers that prefer the umbrella naming. */
export const BEACON_TOOLS = CUSTOMER_360_TOOLS;

/**
 * Per-scope tool allowlist. Beam's tool definitions are ~7-8K tokens total —
 * sending all 15 on every turn for every scope is wasteful when most scopes
 * only meaningfully use 3-6 of them. The whitelist below restricts what the
 * model SEES per scope, which trims the tools payload by ~50-70% on most
 * scopes (estimated $15-30/mo savings, zero quality cost — the model can't
 * call tools it wasn't told about, but the chosen subset is sufficient).
 *
 * Rules of thumb when picking a scope's tools:
 *   - lookup_customer is in every scope so Beam can resolve a name the
 *     surface didn't preload.
 *   - mutators (snooze/pin/mark-contacted/add-note) only on customer-360 —
 *     other scopes don't have the action-card UX to approve them.
 *   - add_fact_to_brain only on customer-360 — fact writes always target a
 *     specific customer the AM is looking at.
 *   - query_customer_book + query_brain are manager cross-book tools; keep
 *     them off customer-360 + customer-specific scopes to avoid the model
 *     reaching for "the book" when it should stay on the visible customer.
 *   - get_full_customer_view is the "tell me everything about X"
 *     fan-out — useful wherever the model might dig into a specific
 *     customer (360, book, post-payment, escalation).
 *
 * Scopes not in this map fall back to the full registry (backwards-compat).
 */
export const SCOPE_TOOL_ALLOWLIST: Partial<Record<AiScope["kind"], BeaconTool[]>> = {
  inbox: [lookupCustomerTool, readCustomerNotesTool],
  "customer-360": [
    lookupCustomerTool,
    readCustomerBrainTool,
    addFactToBrainTool,
    readCustomerNotesTool,
    getChargebeeBillingTool,
    getCustomerPerformanceTool,
    getCustomerFromMetabaseTool,
    getFullCustomerViewTool,
    // META-A3 live dynamic tools — alongside the existing performance/
    // billing reads on Customer 360.
    getBookingHistoryTool,
    getMixpanelActivityTool,
    getReviewSummaryTool,
    draftEmailToContactTool,
    draftSlackMessageTool,
    addNoteTool,
    markContactedTodayTool,
    pinCustomerTool,
    snoozeCustomerTool,
  ],
  "customer-book": [
    lookupCustomerTool,
    queryCustomerBookTool,
    queryBrainTool,
    readCustomerBrainTool,
    getCustomerFromMetabaseTool,
    getFullCustomerViewTool,
    // META-A3 — booking history is the most book-relevant of the three
    // (mixpanel + reviews stay scoped to per-customer surfaces).
    getBookingHistoryTool,
    draftEmailToContactTool,
    draftSlackMessageTool,
  ],
  "performance-landing": [lookupCustomerTool, getCustomerPerformanceTool],
  "performance-report": [
    lookupCustomerTool,
    getCustomerPerformanceTool,
    readCustomerBrainTool,
    getCustomerFromMetabaseTool,
    // META-A3 — performance-report is the natural home for all three
    // live data tools.
    getBookingHistoryTool,
    getMixpanelActivityTool,
    getReviewSummaryTool,
    draftEmailToContactTool,
  ],
  "escalation-overview": [
    lookupCustomerTool,
    readCustomerBrainTool,
    getCustomerFromMetabaseTool,
    // META-A3 — review summary helps escalation triage spot rating
    // collapses faster.
    getReviewSummaryTool,
    draftSlackMessageTool,
    draftEmailToContactTool,
  ],
  "post-payment-book": [
    lookupCustomerTool,
    readCustomerBrainTool,
    getFullCustomerViewTool,
  ],
  "post-payment-customer": [
    lookupCustomerTool,
    readCustomerBrainTool,
    getFullCustomerViewTool,
    draftEmailToContactTool,
  ],
  "miss-payment-overview": [
    lookupCustomerTool,
    queryCustomerBookTool,
    getChargebeeBillingTool,
    getCustomerFromMetabaseTool,
    draftEmailToContactTool,
    draftSlackMessageTool,
  ],
  "negative-keyword-overview": [
    lookupCustomerTool,
    readCustomerBrainTool,
    draftEmailToContactTool,
    draftSlackMessageTool,
  ],
};

/**
 * Look up the tool subset for a given scope. Falls back to the full
 * registry for scopes not in the allowlist (so a new scope added without
 * an allowlist entry keeps the existing behavior — over-permissive but
 * never broken).
 */
export function getToolsForScope(scopeKind: AiScope["kind"]): BeaconTool[] {
  return SCOPE_TOOL_ALLOWLIST[scopeKind] ?? CUSTOMER_360_TOOLS;
}

/**
 * Map of tool-name → tool for O(1) lookup during execute. Built lazily so
 * each import only happens once.
 */
const TOOLS_BY_NAME: Record<string, BeaconTool> = (() => {
  const m: Record<string, BeaconTool> = {};
  for (const t of CUSTOMER_360_TOOLS) m[t.name] = t;
  return m;
})();

/** Get a tool by name. Returns `null` if not in the Wave 1 registry. */
export function getToolByName(name: string): BeaconTool | null {
  return TOOLS_BY_NAME[name] ?? null;
}

/**
 * The on-wire shape sent to Anthropic. Strips the `execute` field — the
 * model never sees the server-side handler.
 */
export function toAnthropicTools(tools: BeaconTool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/** Re-export tools so callers can grab a single tool directly if needed. */
export {
  snoozeCustomerTool,
  pinCustomerTool,
  markContactedTodayTool,
  addNoteTool,
  lookupCustomerTool,
  draftEmailToContactTool,
  draftSlackMessageTool,
  queryCustomerBookTool,
  readCustomerNotesTool,
  readCustomerBrainTool,
  addFactToBrainTool,
  queryBrainTool,
  getChargebeeBillingTool,
  getCustomerPerformanceTool,
  getFullCustomerViewTool,
  getCustomerFromMetabaseTool,
  getBookingHistoryTool,
  getMixpanelActivityTool,
  getReviewSummaryTool,
};
