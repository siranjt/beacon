/**
 * Beacon AI tool executor. Phase E-16 Wave 1.
 *
 * POST /api/ai/action/execute
 *
 * Body:
 *   {
 *     tool_use_id: string,    // Anthropic's id for the proposed tool_use block
 *     tool_name: string,      // must match a tool in the Wave 1 registry
 *     args: Record<string, unknown>,
 *     customer_id: string,    // entity_id — matches args.customer_id
 *   }
 *
 * Returns:
 *   { ok: true,  tool_use_id, summary, data?, idempotent_replay? }
 *   { ok: false, tool_use_id, error }
 *
 * Flow:
 *   1. Auth: AM / manager / admin only.
 *   2. Validate body shape.
 *   3. Rate limit (20 actions per AM per hour) via the existing am_activity_log.
 *   4. Idempotency: for snooze / pin / mark_contacted, swallow re-runs of
 *      identical args within 60s — return the prior result instead of writing.
 *      add_note is allowed to write every time (note bodies are intentional).
 *   5. Resolve customer name + Chargebee handle from the latest snapshot.
 *   6. Look up the tool by name → call execute(args, ctx) → return result.
 *
 * Known v1 gaps (intentional — see E-16 spec):
 *   - We do NOT verify the tool_use_id came from a recent Claude response
 *     server-side. The id is logged for forensic auditing. Closing this gap
 *     properly needs server-side conversation state (Wave 2).
 *   - Rate-limit window is read from am_activity_log via a single SELECT
 *     COUNT(*); accurate enough for 20/hour gating without adding another
 *     storage layer.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import crypto from "crypto";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
import { getSql, readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { logUmbrellaActivity } from "@/lib/activity/log";
import { getToolByName, type ToolExecutionContext } from "@/lib/ai/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Tiered rate limiting (June 2026): read-only tools get a much higher
// budget than mutating tools. Power-use scenarios (a manager exploring
// 10+ customers in an hour) easily fire 50+ read-tool calls but rarely
// need more than ~30 writes — and a runaway write loop costs more
// (DB rows, Slack pings, emails) than a runaway read loop.
//
// Tools are classified by which set they're in below. The COUNT query
// filters am_activity_log on metadata->>'tool' against the matching set
// so each tier consumes its own budget.
const RATE_LIMIT_READ_MAX = 100;
const RATE_LIMIT_WRITE_MAX = 30;
const RATE_LIMIT_WINDOW_MIN = 60;
const READ_ONLY_TOOLS = new Set([
  "lookup_customer",
  "query_customer_book",
  "read_customer_notes",
  "get_chargebee_billing",
  "get_customer_performance",
  // Brain Wave 2a.1 — read-only per-customer fact fetcher.
  "read_customer_brain",
]);
function rateLimitKind(toolName: string): "read" | "write" {
  return READ_ONLY_TOOLS.has(toolName) ? "read" : "write";
}
function rateLimitMaxFor(kind: "read" | "write"): number {
  return kind === "read" ? RATE_LIMIT_READ_MAX : RATE_LIMIT_WRITE_MAX;
}
// Tools that swallow re-runs of identical args within the idempotent window.
// Wave 1 keeps snooze/pin/mark-contacted here (re-running them is almost
// always an accidental double-tap). Wave 2 deliberately omits the draft tools
// (re-drafting is intentional — the AM wants a different angle) and the
// lookup tool (read-only, every call returns fresh).
const IDEMPOTENT_TOOLS = new Set([
  "snooze_customer",
  "pin_customer",
  "mark_contacted_today",
]);
const IDEMPOTENT_WINDOW_SEC = 60;

// Tools whose args do NOT include `customer_id`. The executor's
// single-customer enforcement (args.customer_id must match top-level
// customer_id) is bypassed for these — lookup_customer searches across the
// whole book, query_customer_book aggregates across the whole book, so
// the top-level customer_id is a scope hint, not a target.
const TOOLS_WITHOUT_CUSTOMER_ID_ARG = new Set([
  "lookup_customer",
  "query_customer_book",
  // F-ai-context chunks 2 + 3 — take entity_id directly, no top-level customer_id needed.
  "read_customer_notes",
  "get_chargebee_billing",
  "get_customer_performance",
  // Brain Wave 2a.1 — read_customer_brain takes entity_id directly.
  "read_customer_brain",
]);

interface ExecuteBody {
  tool_use_id?: string;
  tool_name?: string;
  args?: Record<string, unknown>;
  customer_id?: string;
}

function hashArgs(toolName: string, args: Record<string, unknown>): string {
  // Stable JSON stringify by sorting keys — small payloads, deterministic.
  const sortKeys = (val: unknown): unknown => {
    if (Array.isArray(val)) return val.map(sortKeys);
    if (val && typeof val === "object") {
      const o = val as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      Object.keys(o)
        .sort()
        .forEach((k) => {
          out[k] = sortKeys(o[k]);
        });
      return out;
    }
    return val;
  };
  const canonical = JSON.stringify({ tool: toolName, args: sortKeys(args) });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Count beacon_ai action writes by this AM in the last RATE_LIMIT_WINDOW_MIN
 * minutes, filtered to the requested tier ("read" or "write"). Discard /
 * error events DO count — they consume the same model + UI budget as
 * approvals. Filter on metadata->>'tool' so each tier consumes its own
 * budget independently.
 *
 * Unknown tools (anything not in READ_ONLY_TOOLS) count against the write
 * tier — safer default, since the unknown set is far more likely to be a
 * future mutator than a future reader.
 */
async function countRecentActions(
  email: string,
  kind: "read" | "write",
): Promise<number> {
  const sql = getSql();
  if (!sql) return 0;
  const readTools = Array.from(READ_ONLY_TOOLS);
  try {
    const rows =
      kind === "read"
        ? await sql`
            SELECT COUNT(*)::int AS n
            FROM am_activity_log
            WHERE email = ${email}
              AND event_name LIKE 'beacon_ai:action:%'
              AND ts > (NOW() - (${RATE_LIMIT_WINDOW_MIN}::int * INTERVAL '1 minute'))
              AND (metadata->>'tool') = ANY(${readTools})
          `
        : await sql`
            SELECT COUNT(*)::int AS n
            FROM am_activity_log
            WHERE email = ${email}
              AND event_name LIKE 'beacon_ai:action:%'
              AND ts > (NOW() - (${RATE_LIMIT_WINDOW_MIN}::int * INTERVAL '1 minute'))
              AND ((metadata->>'tool') IS NULL OR NOT ((metadata->>'tool') = ANY(${readTools})))
          `;
    const n = (rows[0] as { n?: number } | undefined)?.n;
    return typeof n === "number" ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Look for a prior beacon_ai action row with the same (email, tool, args
 * hash, customer) in the last IDEMPOTENT_WINDOW_SEC seconds. If found,
 * return its summary text + the original action row id — the executor
 * replays the response instead of re-writing.
 */
async function findRecentIdempotent(
  email: string,
  toolName: string,
  customerId: string,
  argsHash: string,
): Promise<{ summary: string | null; ts: string | null } | null> {
  const sql = getSql();
  if (!sql) return null;
  try {
    // The idempotency check keys off the marker row the executor itself writes
    // after a successful tool.execute() — that row carries the args_hash +
    // ok=true flag + the tool name in metadata. Looking at the marker (rather
    // than the per-tool row) lets idempotency stay tool-agnostic and we get
    // a single canonical replay_summary to return.
    const rows = await sql`
      SELECT metadata, ts
      FROM am_activity_log
      WHERE email = ${email}
        AND event_name = 'beacon_ai:action:executed'
        AND entity_id = ${customerId}
        AND metadata->>'tool' = ${toolName}
        AND metadata->>'args_hash' = ${argsHash}
        AND metadata->>'ok' = 'true'
        AND ts > (NOW() - (${IDEMPOTENT_WINDOW_SEC}::int * INTERVAL '1 second'))
      ORDER BY ts DESC
      LIMIT 1
    `;
    const r = rows[0] as
      | { metadata?: Record<string, unknown>; ts?: string | Date }
      | undefined;
    if (!r) return null;
    const summary =
      (r.metadata && typeof r.metadata["replay_summary"] === "string"
        ? (r.metadata["replay_summary"] as string)
        : null) ?? null;
    const ts =
      r.ts instanceof Date ? r.ts.toISOString() : r.ts ?? null;
    return { summary, ts };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  const role = (session.user?.role ?? getRoleForEmail(email)) ?? null;
  if (role !== "admin" && role !== "manager" && role !== "am") {
    return NextResponse.json(
      { ok: false, error: "Forbidden: requires admin / manager / am role" },
      { status: 403 },
    );
  }
  const amName = session.user?.am_name ?? null;

  let body: ExecuteBody;
  try {
    body = (await req.json()) as ExecuteBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }

  const { tool_use_id, tool_name, args, customer_id } = body;
  if (
    !tool_use_id ||
    typeof tool_use_id !== "string" ||
    !tool_name ||
    typeof tool_name !== "string" ||
    !args ||
    typeof args !== "object"
  ) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "tool_use_id, tool_name, and args (object) are required",
      },
      { status: 400 },
    );
  }
  // customer_id is required for every tool except read-only lookups (Wave 2).
  // The book-scope tools (mutators) still need a real entity_id; the executor
  // resolves bizname + Chargebee handle off it for audit + repository writes.
  const customerIdRequired = !TOOLS_WITHOUT_CUSTOMER_ID_ARG.has(tool_name);
  if (customerIdRequired && (!customer_id || typeof customer_id !== "string")) {
    return NextResponse.json(
      {
        ok: false,
        error: "customer_id is required for this tool",
      },
      { status: 400 },
    );
  }
  // Normalize: lookup_customer doesn't act on a single entity, so we tolerate
  // an empty / missing top-level customer_id and replace it with a stable
  // placeholder so downstream audit rows still have something coherent.
  const effectiveCustomerId =
    customerIdRequired ? (customer_id as string) : (customer_id || "lookup_customer:any");

  // Defensive cross-check — args.customer_id must match the top-level
  // customer_id so the model can't fan out to other customers by quietly
  // changing the argument. Exempt tools that don't take a customer_id arg
  // (e.g. lookup_customer searches across the whole book).
  if (
    !TOOLS_WITHOUT_CUSTOMER_ID_ARG.has(tool_name) &&
    typeof args["customer_id"] === "string" &&
    args["customer_id"] !== customer_id
  ) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "args.customer_id must match the top-level customer_id (single-customer enforcement)",
      },
      { status: 400 },
    );
  }

  const tool = getToolByName(tool_name);
  if (!tool) {
    return NextResponse.json(
      { ok: false, error: `Unknown tool: ${tool_name}` },
      { status: 400 },
    );
  }

  // ── Rate limit (tiered: read vs write) ────────────────────────────────
  const kind = rateLimitKind(tool_name);
  const limit = rateLimitMaxFor(kind);
  const recentCount = await countRecentActions(email, kind);
  if (recentCount >= limit) {
    void logUmbrellaActivity({
      email,
      role,
      am_name: amName,
      agent: "customer",
      event_name: "beacon_ai:action:rate_limited",
      surface: "customer-360",
      entity_id: effectiveCustomerId,
      metadata: {
        tool: tool_name,
        tool_use_id,
        kind,
        count_in_window: recentCount,
        window_min: RATE_LIMIT_WINDOW_MIN,
        limit,
      },
    });
    return NextResponse.json(
      {
        ok: false,
        tool_use_id,
        error: `Rate limit hit — Beacon AI can take at most ${limit} ${kind} actions per hour. Try again in a few minutes.`,
      },
      { status: 429 },
    );
  }

  // ── Idempotency replay ────────────────────────────────────────────────
  const argsHash = hashArgs(tool_name, args as Record<string, unknown>);
  if (IDEMPOTENT_TOOLS.has(tool_name)) {
    const prior = await findRecentIdempotent(
      email,
      tool_name,
      effectiveCustomerId,
      argsHash,
    );
    if (prior) {
      void logUmbrellaActivity({
        email,
        role,
        am_name: amName,
        agent: "customer",
        event_name: "beacon_ai:action:idempotent_replay",
        surface: "customer-360",
        entity_id: effectiveCustomerId,
        metadata: {
          tool: tool_name,
          tool_use_id,
          args_hash: argsHash,
          original_ts: prior.ts,
        },
      });
      return NextResponse.json({
        ok: true,
        tool_use_id,
        summary:
          prior.summary ??
          `Already ${tool_name} for this customer moments ago — no duplicate written.`,
        idempotent_replay: true,
      });
    }
  }

  // ── Resolve customer name + cb handle from the latest snapshot ────────
  // lookup_customer doesn't act on a specific customer; skip the snapshot
  // round-trip — the tool itself reads the snapshot and constructs its own
  // result list.
  let customerName: string | null = null;
  let cbCustomerId: string | null = null;
  if (customerIdRequired) {
    try {
      const snap = await readLatestSnapshotV2();
      const sc =
        snap?.customers?.find((c) => c.entity_id === effectiveCustomerId) ??
        null;
      customerName = sc?.company ?? null;
      cbCustomerId = sc?.customer_id ?? null;
    } catch {
      // Best-effort — we still execute even if the snapshot lookup fails.
    }
  }

  // ── Execute the tool ──────────────────────────────────────────────────
  const ctx: ToolExecutionContext = {
    amEmail: email,
    amName,
    role,
    customerId: effectiveCustomerId,
    customerName,
    cbCustomerId,
  };

  try {
    const result = await tool.execute(
      args as Record<string, unknown>,
      ctx,
    );

    // Pin a small marker row so /api/ai/action/execute can find this run
    // for idempotency replay. Stored next to the tool's own activity row.
    void logUmbrellaActivity({
      email,
      role,
      am_name: amName,
      agent: "customer",
      event_name: "beacon_ai:action:executed",
      surface: "customer-360",
      entity_id: effectiveCustomerId,
      metadata: {
        tool: tool_name,
        tool_use_id,
        args_hash: argsHash,
        ok: result.ok,
        replay_summary: result.ok ? result.summary : null,
      },
    });

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, tool_use_id, error: result.error },
        { status: 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      tool_use_id,
      summary: result.summary,
      data: result.data ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void logUmbrellaActivity({
      email,
      role,
      am_name: amName,
      agent: "customer",
      event_name: "beacon_ai:action:exception",
      surface: "customer-360",
      entity_id: effectiveCustomerId,
      metadata: { tool: tool_name, tool_use_id, error: msg },
    });
    return NextResponse.json(
      { ok: false, tool_use_id, error: msg },
      { status: 500 },
    );
  }
}

/**
 * POST also accepts a `discard` mode so we audit the AM choosing NOT to
 * approve a proposed action. The client sends `{ ..., discard: true }` and
 * the executor returns immediately with a logged row.
 *
 * Implemented as a separate path on the same endpoint to keep the wire shape
 * simple — the client doesn't need a second URL.
 */
export async function PUT(req: NextRequest) {
  // Discards land on PUT — kept distinct from POST so we never confuse
  // "discard logged" with "executed". The body is the same shape minus args.
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const role = getRoleForEmail(email);
  if (role !== "admin" && role !== "manager" && role !== "am") {
    return NextResponse.json(
      { ok: false, error: "Forbidden: requires admin / manager / am role" },
      { status: 403 },
    );
  }
  const amName = (session.user?.am_name as string | null) ?? null;

  let body: ExecuteBody;
  try {
    body = (await req.json()) as ExecuteBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }
  const { tool_use_id, tool_name, args, customer_id } = body;
  if (!tool_use_id || !tool_name) {
    return NextResponse.json(
      {
        ok: false,
        error: "tool_use_id and tool_name are required",
      },
      { status: 400 },
    );
  }
  // Wave 2 — customer_id is optional for tools that don't act on one specific
  // customer (lookup). For everything else we still require it, but discards
  // are audit-only so we tolerate a missing value and store an explicit
  // placeholder rather than erroring.
  const discardEntityId = customer_id || "(none)";

  void logUmbrellaActivity({
    email,
    role,
    am_name: amName,
    agent: "customer",
    event_name: `beacon_ai:action:${tool_name}:discarded`,
    surface: "customer-360",
    entity_id: discardEntityId,
    metadata: {
      source: "beacon_ai",
      tool: tool_name,
      tool_use_id,
      args: args ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    tool_use_id,
    discarded: true,
  });
}
