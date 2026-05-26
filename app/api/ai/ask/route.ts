/**
 * Universal AI copilot endpoint. Phase E-9.
 *
 * POST /api/ai/ask
 *
 * Body:
 *   {
 *     scope: AiScope,  // discriminated by `kind`
 *     question: string,
 *     history?: Array<{ role: "user" | "assistant", content: string }>,
 *   }
 *
 * Streams a Haiku response grounded in scope-appropriate context loaded
 * server-side. Replaces the customer-360-specific endpoint with one that
 * works across every Beacon surface (inbox, customer book, customer
 * detail, performance landing/report, escalation queue, post-payment
 * book/customer).
 *
 * The scope determines:
 *   1. Which context loader runs (lib/ai/context-loaders.ts)
 *   2. Which system prompt frames the conversation (lib/ai/prompts.ts)
 *
 * Auth: any signed-in zoca user. Data exposed is no more sensitive than
 * what each agent already surfaces to that user.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import Anthropic from "@anthropic-ai/sdk";
import { authOptions } from "@/lib/auth";
import { logUmbrellaActivity } from "@/lib/activity/log";
import { getRoleForEmail } from "@/lib/customer/config";
import type { AiScope } from "@/lib/ai/scopes";
import { scopeKey } from "@/lib/ai/scopes";
import {
  getRecentCrossScope,
  getScopeConversations,
  renderMemoryForPrompt,
  saveTurn,
} from "@/lib/ai/memory";
import { listFactsForUser, renderFactsForPrompt } from "@/lib/ai/facts";
import {
  loadCustomer360Context,
  loadCustomerBookContext,
  loadEscalationOverviewContext,
  loadInboxContext,
  loadPerformanceLandingContext,
  loadPerformanceReportContext,
  loadPostPaymentBookContext,
  loadPostPaymentCustomerContext,
  type LoadedContext,
} from "@/lib/ai/context-loaders";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { CUSTOMER_360_TOOLS, toAnthropicTools } from "@/lib/ai/tools";
import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Default model — Sonnet 4.6 for the interactive copilot. Haiku is faster +
// cheaper but Sonnet is materially better at reasoning across the rich
// per-scope context blobs (especially "patterns across the book", "why is
// this RED", and "compare these customers"). Streaming hides most of the
// latency gap. Override with ANTHROPIC_ASK_MODEL=haiku in env to flip
// back; per-question overrides aren't exposed in v1.
const MODEL = process.env.ANTHROPIC_ASK_MODEL ?? "claude-sonnet-4-6";
const MAX_TOKENS = 2400;
const MAX_HISTORY_TURNS = 6;
const MAX_QUESTION_CHARS = 2000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

interface AskBody {
  scope?: AiScope;
  question?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

function isValidScope(s: unknown): s is AiScope {
  if (!s || typeof s !== "object") return false;
  const k = (s as { kind?: unknown }).kind;
  switch (k) {
    case "inbox":
    case "customer-book":
    case "performance-landing":
    case "escalation-overview":
    case "post-payment-book":
      return true;
    case "customer-360":
    case "performance-report":
      return typeof (s as { entityId?: unknown }).entityId === "string";
    case "post-payment-customer":
      return typeof (s as { cbCustomerId?: unknown }).cbCustomerId === "string";
    case "hidden":
      return false; // refuse hidden scopes — nothing to ask about
    default:
      return false;
  }
}

async function loadContextForScope(
  scope: AiScope,
  user: { am_name: string | null; role: "admin" | "manager" | "am" | null },
): Promise<LoadedContext> {
  switch (scope.kind) {
    case "inbox":
      return loadInboxContext({
        amFilter: user.role === "am" ? user.am_name : null,
      });
    case "customer-360":
      return loadCustomer360Context(scope.entityId);
    case "customer-book":
      return loadCustomerBookContext({
        amFilter: user.role === "am" ? user.am_name : null,
      });
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
    case "hidden":
      throw new Error("hidden scope cannot be asked");
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: AskBody;
  try {
    body = (await req.json()) as AskBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const question = body.question?.trim();
  if (!question) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      { error: `question too long (max ${MAX_QUESTION_CHARS} chars)` },
      { status: 400 },
    );
  }
  if (!isValidScope(body.scope)) {
    return NextResponse.json(
      { error: "valid scope is required" },
      { status: 400 },
    );
  }
  const scope = body.scope;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 503 },
    );
  }

  const role = getRoleForEmail(email);
  const amName = session.user?.am_name ?? null;

  // Load scope-specific context.
  let ctx: LoadedContext;
  try {
    ctx = await loadContextForScope(scope, { am_name: amName, role });
  } catch (e) {
    return NextResponse.json(
      {
        error: `couldn't load context for scope ${scope.kind}: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    );
  }

  // Trim conversation history sent by the client (in-memory turns from
  // the current open drawer — used as immediate context).
  const history = Array.isArray(body.history) ? body.history : [];
  const trimmed = history.slice(-MAX_HISTORY_TURNS * 2);

  // Phase E-9 memory — load PERSISTED history from Postgres for both:
  //   1. The current scope (what we've discussed about THIS customer/inbox)
  //   2. Other recent scopes (what they've been talking about lately)
  // The two blocks are formatted as plain text and injected into the
  // system prompt below. Beacon decides whether to reference them based
  // on relevance.
  const sKey = scopeKey(scope);
  const [scopeHistory, crossScope, facts] = await Promise.all([
    getScopeConversations(email, sKey, 30).catch(() => []),
    getRecentCrossScope(email, sKey, 18).catch(() => []),
    // Phase E-9 · Phase 2 — distilled facts about the user.
    // Phase E-12 — surface-aware filtering: pass the current scope so we
    // pick up scope-pinned style preferences alongside global ones. Facts
    // with scope_key NULL apply everywhere; scope_key matching only here.
    listFactsForUser(email, { scopeKey: sKey }).catch(() => []),
  ]);
  const memoryBlocks = renderMemoryForPrompt(scopeHistory, crossScope);
  const userProfile = renderFactsForPrompt(facts);
  // Phase E-12 (E-12.3) — capture which fact IDs were active when this
  // response was generated. Stored in the assistant turn's metadata so the
  // thumbs up/down feedback loop knows which facts to reinforce or demote.
  const activeFactIds = facts.map((f) => f.id);

  // Telemetry (fire-and-forget).
  void logUmbrellaActivity({
    email,
    role,
    am_name: amName,
    agent: "umbrella",
    event_name: "claude_asked",
    surface: "launcher",
    entity_id:
      scope.kind === "customer-360" || scope.kind === "performance-report"
        ? scope.entityId
        : null,
    metadata: {
      kind: "ai_ask",
      scope_kind: scope.kind,
      scope_key: scopeKey(scope),
      audience: ctx.audience,
      question_length: question.length,
      history_turns: Math.floor(trimmed.length / 2),
      ...ctx.meta,
    },
  });

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...trimmed.map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, 4000),
    })),
    { role: "user", content: question },
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      let assistantBuf = "";
      // Phase E-16 Wave 1.5 — tool use available in every customer-aware
      // scope: Customer 360 (one customer in URL), Customer Beacon book
      // (multi-customer list, AI picks from CONTEXT.customers), Performance
      // Beacon report (one customer in URL), Escalation overview (ticket
      // queue spans many customers — AI picks from the open-ticket list).
      // The 4 tools all require customer_id; for multi-customer scopes the
      // scope prompts teach the model how to resolve "which one" from the
      // conversation against the customer list already in CONTEXT.
      const wantsTools =
        scope.kind === "customer-360" ||
        scope.kind === "customer-book" ||
        scope.kind === "performance-report" ||
        scope.kind === "escalation-overview";
      const tools = wantsTools ? toAnthropicTools(CUSTOMER_360_TOOLS) : undefined;
      try {
        const sdkStream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: buildSystemPrompt(scope, ctx.blob, memoryBlocks, userProfile),
          messages,
          ...(tools ? { tools } : {}),
        });
        sdkStream.on("text", (delta: string) => {
          assistantBuf += delta;
          send({ delta });
        });
        // Phase E-16 Wave 1 — fire a `tool_use` SSE frame for each tool_use
        // content block once its JSON input has finalized. The client renders
        // an ActionCard from this and executes ONLY after the AM clicks
        // Approve (separate /api/ai/action/execute endpoint).
        sdkStream.on("contentBlock", (block: ContentBlock) => {
          if (block.type !== "tool_use") return;
          send({
            tool_use: {
              id: block.id,
              name: block.name,
              input: block.input,
            },
          });
        });
        await sdkStream.finalMessage();

        // Phase E-12 — persist turns BEFORE closing the stream so we can
        // send the assistant turn id in the final SSE frame. The client uses
        // this id to target thumbs up/down feedback at the right turn.
        // We still keep it best-effort: if the write fails, we send done:true
        // without a turn id and feedback just won't be available for this turn.
        let assistantTurnId: number | null = null;
        try {
          // User turn is fire-and-forget (no need for its id downstream).
          void saveTurn({
            email,
            scope_key: sKey,
            role: "user",
            content: question,
            metadata: { audience: ctx.audience, ...ctx.meta },
          });
          // Assistant turn id is needed for feedback — wait for the write
          // so we can include the id in the final SSE message.
          assistantTurnId = await saveTurn({
            email,
            scope_key: sKey,
            role: "assistant",
            content: assistantBuf,
            metadata: {
              model: MODEL,
              audience: ctx.audience,
              // Phase E-12 (E-12.3) — store which facts were active when
              // generating this response so /api/ai/feedback can look them
              // up by turn id and apply confidence adjustments.
              active_fact_ids: activeFactIds,
              scope_key: sKey,
            },
          });
        } catch (e) {
          // Persistence failures shouldn't fail the response — just log and
          // continue without a turn id.
          // eslint-disable-next-line no-console
          console.warn(
            "[ai/ask] saveTurn failed:",
            e instanceof Error ? e.message : String(e),
          );
        }

        send({
          done: true,
          audience: ctx.audience,
          turn_id: assistantTurnId,
          feedback_enabled: assistantTurnId !== null,
        });
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.error("[ai/ask] stream error", msg);
        send({ error: msg });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
