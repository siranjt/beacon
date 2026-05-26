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
 * Wave 1 ships exactly four Customer-360 scoped tools:
 *   - snooze_customer
 *   - pin_customer
 *   - mark_contacted_today
 *   - add_note
 *
 * Wave 2 (NOT in this phase) will add email drafting, Slack drafting, batch
 * actions, and expansion to other scopes.
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

import { snoozeCustomerTool } from "./snooze";
import { pinCustomerTool } from "./pin";
import { markContactedTodayTool } from "./mark-contacted";
import { addNoteTool } from "./add-note";

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
 * Customer-360 scoped tools — Wave 1.
 *
 * Order is meaningful: Claude can see all tools simultaneously, but in the
 * system prompt we suggest snooze/pin/mark-contacted first because they're
 * the most common AM actions per the Customer 360 design doc.
 */
export const CUSTOMER_360_TOOLS: BeaconTool[] = [
  snoozeCustomerTool,
  pinCustomerTool,
  markContactedTodayTool,
  addNoteTool,
];

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
export { snoozeCustomerTool, pinCustomerTool, markContactedTodayTool, addNoteTool };
