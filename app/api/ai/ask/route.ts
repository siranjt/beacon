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

  // Trim conversation history.
  const history = Array.isArray(body.history) ? body.history : [];
  const trimmed = history.slice(-MAX_HISTORY_TURNS * 2);

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
      try {
        const sdkStream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: buildSystemPrompt(scope, ctx.blob),
          messages,
        });
        sdkStream.on("text", (delta: string) => {
          send({ delta });
        });
        await sdkStream.finalMessage();
        send({ done: true, audience: ctx.audience });
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
