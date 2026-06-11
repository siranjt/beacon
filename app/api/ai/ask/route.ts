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
import { parseGaps, logGaps } from "@/lib/ai/gaps";
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
  loadMissPaymentOverviewContext,
  loadNegativeKeywordOverviewContext,
  loadPerformanceLandingContext,
  loadPerformanceReportContext,
  loadPostPaymentBookContext,
  loadPostPaymentCustomerContext,
  type LoadedContext,
} from "@/lib/ai/context-loaders";
import { buildSystemBlocks } from "@/lib/ai/prompts";
import { getToolsForScope, toAnthropicTools } from "@/lib/ai/tools";
import { routeTools, type RoutingDecision } from "@/lib/ai/tool-router";
import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
// Phase G — Knowledge Base. Each request retrieves top-K relevant docs
// scoped to the surface; the chunks are injected into CONTEXT and a kb
// citation lookup is merged alongside the scope-specific one.
import { searchDocs } from "@/lib/ai/knowledge";
import { buildKnowledgeCitations } from "@/lib/ai/citations";

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
// 2000 chars for human-typed questions. Tool-continuation messages
// (synthetic follow-ups from askWithToolResult containing the tool
// output that should feed back to the model) can carry several KB of
// structured data — Chargebee/Performance tools easily produce 3-8KB
// JSON payloads. We detect those by their "[Beacon ran" / "[Beacon's"
// prefix and allow up to MAX_TOOL_CONTINUATION_CHARS.
const MAX_QUESTION_CHARS = 2000;
const MAX_TOOL_CONTINUATION_CHARS = 16000;
function isToolContinuation(q: string): boolean {
  return q.startsWith("[Beacon ran ") || q.startsWith("[Beacon's ");
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

interface AskBody {
  scope?: AiScope;
  question?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * F-polish-AI Tier 4 — extra citation entries to merge into this turn's
   * citationLookup. Used by the client-orchestrated continuation after a
   * `query_customer_book` tool execution: the tool builds synthetic
   * citations for each (group_key, bucket) cell, the client passes them
   * here, and the server merges them into the SSE citations frame so the
   * model's `[cite:count:query:...]` chips render with real popovers.
   */
  extra_citations?: Record<string, unknown>;
}

/**
 * F-polish-AI Tier 3 — pull the scope's identifying params (entity_id /
 * cb_customer_id / am-filter context) into a plain JSON object so the
 * failure-log row can be filtered by surface later. Whole-book scopes
 * with no entity return null.
 */
function scopeMetaForLog(s: AiScope): Record<string, unknown> | null {
  switch (s.kind) {
    case "customer-360":
    case "performance-report":
      return { entity_id: s.entityId };
    case "post-payment-customer":
      return { cb_customer_id: s.cbCustomerId };
    case "inbox":
    case "customer-book":
    case "performance-landing":
    case "escalation-overview":
    case "post-payment-book":
    case "miss-payment-overview":
      return null;
    case "negative-keyword-overview":
      return null;
    case "hidden":
      return null;
  }
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
    case "miss-payment-overview":
    case "negative-keyword-overview":
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
    case "miss-payment-overview":
      // Phase F-polish-AI: real loader pulls Chargebee invoices + ACH +
      // BaseSheet + tickets + annotations and aggregates per-AM rollup,
      // multi-month repeats, auto-debit Off + high-balance bucket, and
      // recovery-coverage signals. Mirrors the dashboard's NDJSON pipeline.
      return loadMissPaymentOverviewContext();
    case "negative-keyword-overview":
      // Phase NK-Beam: pulls beacon_negative_keyword_alerts + aggregates
      // counts by category / source / AM, surfaces top open alerts.
      // AM-scoped via user.am_name; manager/admin see all.
      return loadNegativeKeywordOverviewContext({
        amFilter: user.role === "am" ? user.am_name : null,
      });
    case "hidden":
      throw new Error("hidden scope cannot be asked");
  }
}

export async function POST(req: NextRequest) {
  // Phase E-17.3c — eval harness service-token bypass. The weekly eval
  // cron hits this endpoint to score Beam quality. It can't carry a
  // user session (it's a server-to-server call), so we accept a shared
  // service token via x-eval-runner-token header. The token is set as the
  // EVAL_RUNNER_TOKEN env var. Bypassed user is identified as a synthetic
  // "eval-runner@zoca.ai" with admin role for context loading.
  const evalToken = req.headers.get("x-eval-runner-token");
  const expectedEvalToken = process.env.EVAL_RUNNER_TOKEN;
  const isEvalRunner =
    !!evalToken && !!expectedEvalToken && evalToken === expectedEvalToken;

  const session = isEvalRunner ? null : await getServerSession(authOptions);
  const email = isEvalRunner ? "eval-runner@zoca.ai" : session?.user?.email;
  if (!email) {
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
  const lengthCap = isToolContinuation(question)
    ? MAX_TOOL_CONTINUATION_CHARS
    : MAX_QUESTION_CHARS;
  if (question.length > lengthCap) {
    return NextResponse.json(
      { error: `question too long (max ${lengthCap} chars)` },
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

  const role = isEvalRunner ? "admin" : getRoleForEmail(email);
  const amName = isEvalRunner ? null : (session?.user?.am_name ?? null);

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

  // Phase G — Knowledge Base retrieval. Search beacon_ai_docs for chunks
  // relevant to this question, filtered to docs tagged with the current
  // scope (or 'all'). Top-K chunks get inlined into the CONTEXT blob and
  // their citation keys merged into the lookup so the model can emit
  // [cite:kb:<slug>] markers. Soft-fails to no-op on retrieval errors —
  // the rest of the request still works without KB context.
  //
  // OPT-3 — DEFAULT_KB_CHUNK_LIMIT is the per-turn ceiling. Audit data
  // showed most answers cite 1-2 chunks; the old default of 10 inflated
  // the prompt by ~5K tokens per turn for no measurable answer-quality
  // gain. Bumping back up should be tied to a specific failure mode
  // (e.g. KB recall miss in evals), not vibes. customer-360 +
  // customer-book are the heaviest scopes — we intentionally keep them
  // at this same limit instead of letting them request more.
  const DEFAULT_KB_CHUNK_LIMIT = 3;
  try {
    const kbChunks = await searchDocs(question, scope, DEFAULT_KB_CHUNK_LIMIT);
    if (kbChunks.length > 0) {
      // Inject the chunks into the existing JSON blob. Reuses the loader's
      // already-stringified blob: parse → add → restringify. This is the
      // cleanest patch point that doesn't require every per-scope loader
      // to know about KB.
      try {
        const blobObj = JSON.parse(ctx.blob);
        blobObj._knowledge_base = kbChunks.map((c) => ({
          slug: c.slug,
          title: c.title,
          section: c.section,
          excerpt: c.excerpt,
          citation_key: `kb:${c.slug}`,
        }));
        ctx.blob = JSON.stringify(blobObj, null, 2);
      } catch {
        // Loader emitted non-JSON blob (shouldn't happen with current
        // loaders, but guard against future scopes). Skip injection.
      }
      // Merge KB citations into the lookup so the client renders chips.
      const kbCitations = buildKnowledgeCitations(kbChunks);
      ctx.citationLookup = {
        ...(ctx.citationLookup ?? {}),
        ...kbCitations,
      };
    }
  } catch (kbErr) {
    console.warn("[ask] KB retrieval failed (non-fatal):", kbErr);
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
      // Phase E-16 Wave 2 — tool use available in every customer-aware scope
      // plus inbox + post-payment surfaces. The new lookup_customer tool lets
      // the model resolve a customer the inbox / post-payment-book don't
      // surface yet ("draft an email to Acme Salon" even when Acme isn't on
      // today's inbox). Mutators (snooze / pin / mark-contacted / add-note /
      // draft-email / draft-slack) still need a customer_id; the scope
      // prompts teach the model to call lookup_customer FIRST when the
      // current CONTEXT doesn't already list the named customer.
      const wantsTools =
        scope.kind === "customer-360" ||
        scope.kind === "customer-book" ||
        scope.kind === "performance-report" ||
        scope.kind === "escalation-overview" ||
        scope.kind === "inbox" ||
        scope.kind === "post-payment-book" ||
        scope.kind === "post-payment-customer" ||
        // Phase F-polish-AI — miss-payment-overview gets tools so Beacon
        // can draft chase emails / Slack messages and resolve biznames
        // beyond the top-30 sample via lookup_customer.
        scope.kind === "miss-payment-overview" ||
        // Phase NK-Beam — negative-keyword-overview gets tools so Beam
        // can call read_customer_brain on any flagged customer, draft
        // outreach via draft_email/draft_slack, and use query_customer_book
        // or query_brain for cross-book analysis.
        scope.kind === "negative-keyword-overview" ||
        // Performance-landing was missing — give it the same tool set so
        // Beam can lookup customers + draft outreach from there too.
        scope.kind === "performance-landing";
      // OPT-2 — per-scope tool whitelist. Each scope now receives only the
      // subset of tools it actually uses. Customer-360 keeps the full
      // mutator suite; the inbox gets just lookup + read_notes; etc. This
      // trims the tools payload by 50-70% on most scopes (~1-3K tokens per
      // call). Scopes without an explicit allowlist entry fall back to the
      // full registry inside getToolsForScope.
      const scopeTools = getToolsForScope(scope.kind);
      // SMART-B2 — two-stage tool routing. Before handing the full per-scope
      // subset to Sonnet, ask Haiku which 1-3 tools the question actually
      // needs. Trims tool definitions further on rich scopes (customer-360
      // sends 13; many questions only need 1-2). Soft-fails to the full
      // scopeTools set on any error — Beam quality never regresses.
      //
      // We pay ~300-500ms of Haiku latency here. The SSE stream is already
      // open + the citations frame has been flushed, so the user sees the
      // panel start; first token arrives slightly later than before. Net
      // win because the larger Sonnet prompt would've added comparable wall
      // time anyway, and the trimmed tool set lowers downstream cost.
      let routingDecision: RoutingDecision | null = null;
      let routedTools = scopeTools;
      if (wantsTools) {
        try {
          routingDecision = await routeTools(scope, question, scopeTools);
          routedTools = routingDecision.tools;
          // eslint-disable-next-line no-console
          console.log(
            `[router] scope=${scope.kind} picked=${routingDecision.tools.length} ` +
              `from=${routingDecision.candidateCount} ` +
              `cache=${routingDecision.cacheHit ? "HIT" : "MISS"} ` +
              `routed=${routingDecision.routed}` +
              (routingDecision.skipReason
                ? ` skip=${routingDecision.skipReason}`
                : ""),
          );
        } catch (e) {
          // Belt + suspenders — routeTools already soft-fails internally.
          // eslint-disable-next-line no-console
          console.warn(
            "[router] unexpected throw — falling back to full scope tools:",
            e instanceof Error ? e.message : String(e),
          );
          routedTools = scopeTools;
        }
      }
      const tools = wantsTools ? toAnthropicTools(routedTools) : undefined;
      // Phase E-17 Wave 3a — emit the citation lookup at stream start so the
      // client can render `[cite:KEY]` chips in deltas as they arrive. Empty
      // lookups (scopes without v1 support) still send the frame so the
      // client always knows the start of the stream is reached.
      //
      // F-polish-AI Tier 4 — merge any extra_citations from the request body.
      // The continuation after a query_customer_book execute passes the
      // tool's synthetic citations here so the model's table cells get real
      // popovers, not "(unverified)" fallback chips. Body-supplied keys win
      // over scope-supplied keys on collision (the tool result is the more
      // recent source of truth).
      const extraCitationsIn = body.extra_citations;
      const mergedCitationLookup = {
        ...(ctx.citationLookup ?? {}),
        ...(extraCitationsIn && typeof extraCitationsIn === "object"
          ? (extraCitationsIn as Record<string, unknown>)
          : {}),
      };
      if (Object.keys(mergedCitationLookup).length > 0) {
        send({ citations: mergedCitationLookup });
      }

      try {
        // OPT-1 — prompt caching. Same pattern as
        // lib/post-payment/evaluator/anthropic.ts. The system prompt is split
        // into a stable `common` block (identity / reasoning / voice — same
        // across all 11 scopes) + a `scopeStatic` block (per-scope framing —
        // same for every call on this scope) + a `volatileTail` (timestamp,
        // memory, CONTEXT JSON — changes every call).
        //
        // Two `cache_control: ephemeral` markers create two cache breakpoints.
        // The common block hits across every scope; the per-scope block hits
        // when the same user stays on one surface. The volatile tail is
        // unmarked so cache lookups land on a stable prefix.
        //
        // The tools array also gets one `cache_control` marker on the LAST
        // tool entry. Per Anthropic's docs, one marker on the tools list
        // caches the entire tools block. The per-scope tool subset (from
        // OPT-2's getToolsForScope) is identical across calls on the same
        // scope, so this hits whenever tools are enabled.
        //
        // SDK 0.30.x types don't expose `cache_control` on the relevant
        // union shapes (TextBlockParam, Tool) — runtime accepts them fine
        // since prompt caching is GA. We cast to `any`, mirroring the
        // approach in lib/post-payment/evaluator/anthropic.ts.
        const blocks = buildSystemBlocks(
          scope,
          ctx.blob,
          memoryBlocks,
          userProfile,
        );
        const systemArr: unknown[] = blocks.common
          ? [
              {
                type: "text",
                text: blocks.common,
                cache_control: { type: "ephemeral" },
              },
              {
                type: "text",
                text: blocks.scopeStatic,
                cache_control: { type: "ephemeral" },
              },
              { type: "text", text: blocks.volatileTail },
            ]
          : [{ type: "text", text: blocks.volatileTail }];
        const cachedTools = tools
          ? tools.map((t, i) =>
              i === tools.length - 1
                ? { ...t, cache_control: { type: "ephemeral" } }
                : t,
            )
          : undefined;
        const sdkStream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: systemArr as any,
          messages,
          ...(cachedTools ? { tools: cachedTools as any } : {}),
        } as any);
        sdkStream.on("text", (delta: string) => {
          assistantBuf += delta;
          send({ delta });
        });
        // Phase E-16 Wave 1 — fire a `tool_use` SSE frame for each tool_use
        // content block once its JSON input has finalized. The client renders
        // an ActionCard from this and executes ONLY after the AM clicks
        // Approve (separate /api/ai/action/execute endpoint).
        //
        // FIX E-16.C — enforce a HARD one-tool-per-turn cap. Even when the
        // prompt says "act on one at a time", Sonnet sometimes emits multiple
        // tool_use blocks in a single response (e.g. "pin all three"). Letting
        // them all through would (a) violate the contract the prompt promises
        // the AM and (b) cause concurrent approve cards that race the
        // follow-up streaming turn. Cap to the first; tell the AM via a
        // delta what happened so the conversation reads cleanly.
        let toolUsesEmitted = 0;
        sdkStream.on("contentBlock", (block: ContentBlock) => {
          if (block.type !== "tool_use") return;
          if (toolUsesEmitted >= 1) {
            // Note: we don't have a clean way to send "this is a system
            // note from Beacon, not a model token" — surfacing via the same
            // delta channel keeps the UX coherent. The AI will see it on
            // its next turn (as part of the conversation transcript) and
            // adjust naturally.
            const skipped = `\n\n_(Beacon: I can only act on one customer at a time. Skipping the rest — start with this one, then ask me again for the next.)_`;
            assistantBuf += skipped;
            send({ delta: skipped });
            return;
          }
          toolUsesEmitted += 1;
          send({
            tool_use: {
              id: block.id,
              name: block.name,
              input: block.input,
            },
          });
        });
        const finalMsg = await sdkStream.finalMessage();

        // OPT-1 — log cache hit metrics. usage.cache_creation_input_tokens
        // is what we wrote into cache this call (paid 1.25x rate);
        // usage.cache_read_input_tokens is what we hit (paid 0.1x rate).
        // Regular input_tokens is everything not cached. Logging all four
        // lets us track hit ratio + savings over time. SDK 0.30 doesn't type
        // these fields, so widen via `any`.
        try {
          const u: any = (finalMsg as any)?.usage ?? {};
          const cacheRead = u.cache_read_input_tokens ?? 0;
          const cacheWrite = u.cache_creation_input_tokens ?? 0;
          const inputTok = u.input_tokens ?? 0;
          const outputTok = u.output_tokens ?? 0;
          // eslint-disable-next-line no-console
          console.log(
            `[ask] scope=${scope.kind} model=${MODEL} ` +
              `input=${inputTok} cache_create=${cacheWrite} ` +
              `cache_read=${cacheRead} output=${outputTok} ` +
              `cache=${cacheRead > 0 ? "HIT" : cacheWrite > 0 ? "WRITE" : "MISS"}`,
          );
        } catch {
          // metric logging is best-effort — never break the response on it.
        }

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
              // SMART-B2 — capture the two-stage routing decision so we can
              // audit how aggressively Haiku is trimming tools per scope.
              // `null` means tools weren't enabled for this scope.
              tool_routing: routingDecision
                ? {
                    routed: routingDecision.routed,
                    cache_hit: routingDecision.cacheHit,
                    picked: routingDecision.pickedNames,
                    candidate_count: routingDecision.candidateCount,
                    skip_reason: routingDecision.skipReason ?? null,
                  }
                : null,
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

        // F-polish-AI Tier 3 — failure inbox. Parse `<gap: ...>` markers
        // out of the assistant turn and log one row per gap. Best-effort;
        // never blocks stream completion. The markers themselves stay in
        // assistantBuf (and thus in the saved turn) so admins can see
        // exactly what the model said when triaging — the client renderer
        // strips them from the visible bubble.
        try {
          const gaps = parseGaps(assistantBuf);
          if (gaps.length > 0) {
            void logGaps({
              scope: scope.kind,
              scope_meta: scopeMetaForLog(scope),
              user_email: email,
              user_role: role,
              question,
              full_response: assistantBuf,
              conversation_id: assistantTurnId,
              gaps,
            });
          }
        } catch (e) {
          console.warn(
            "[ai/ask] gap logging failed:",
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
