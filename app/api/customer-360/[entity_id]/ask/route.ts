/**
 * Ask Claude about a customer — Phase E-9 AI copilot.
 *
 * POST /api/customer-360/[entity_id]/ask
 *
 * Streams a Haiku response grounded in the customer's full 360 data
 * (Customer Beacon signals, Performance metrics, Escalation tickets,
 * Post-Payment verdict). Used by the floating "Ask Claude" panel on the
 * /360 page so AMs can reason about a customer without context-switching.
 *
 * Body:
 *   {
 *     question: string,
 *     history?: Array<{ role: "user" | "assistant", content: string }>,
 *   }
 *
 * Response: SSE stream with two event kinds:
 *   data: {"delta": "..."}       — token chunks (concat in order)
 *   data: {"done": true}         — final marker
 *   data: {"error": "..."}       — fatal error (terminal)
 *
 * Why server-side data refetch (instead of trusting the client to pass it):
 *   1. Auth boundary — client can't manufacture a customer's signals
 *   2. Fresh data — the user could leave the 360 tab open for hours
 *   3. Smaller request body — client sends just the question
 *
 * Cost: a 4 KB system prompt + ~500 token answer ≈ $0.001 per question on
 * Haiku. Negligible at internal-tool volumes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import Anthropic from "@anthropic-ai/sdk";
import { authOptions } from "@/lib/auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { fetchEntityReportData } from "@/lib/report/fetchers";
import { fetchTicketsForCustomer } from "@/lib/escalation/tickets";
import { getCustomer } from "@/lib/post-payment/db/queries";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import { logUmbrellaActivity } from "@/lib/activity/log";
import { getRoleForEmail } from "@/lib/customer/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = process.env.ANTHROPIC_ASK_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1200;
const MAX_HISTORY_TURNS = 6;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

interface AskBody {
  question?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

/** Find one customer in the snapshot by entity_id. */
function findInSnapshot(
  snap: { customers?: ScoredCustomerV2[] } | null,
  entityId: string,
): ScoredCustomerV2 | null {
  if (!snap?.customers) return null;
  return snap.customers.find((c) => c.entity_id === entityId) ?? null;
}

/** Build a compact, JSON-rendered context blob from all four agents. */
async function buildCustomerContext(entityId: string): Promise<{
  bizName: string;
  cbCustomerId: string | null;
  blob: string;
}> {
  const snap = await readLatestSnapshotV2().catch(() => null);
  const sc = findInSnapshot(snap, entityId);

  const [perfR, escR, ppR] = await Promise.allSettled([
    fetchEntityReportData(entityId),
    fetchTicketsForCustomer({ entityId }),
    sc?.customer_id ? getCustomer(sc.customer_id) : Promise.resolve(null),
  ]);

  // Trim performance to the high-signal bits — we don't need every raw row.
  const perf = perfR.status === "fulfilled" && perfR.value ? perfR.value : null;
  const escalations = escR.status === "fulfilled" ? escR.value : [];
  const postPayment = ppR.status === "fulfilled" ? ppR.value : null;

  const blob = JSON.stringify(
    {
      identity: {
        entity_id: entityId,
        biz_name: sc?.company ?? null,
        am_name: sc?.am_name ?? null,
        ae_name: sc?.ae_name ?? null,
        cb_customer_id: sc?.customer_id ?? null,
        pod: (sc as { pod?: string } | null)?.pod ?? null,
      },
      signals: sc
        ? {
            composite: sc.signals_v2?.composite,
            tier: sc.signals_v2?.tier,
            stoplight: sc.signals_v2?.stoplight,
            sub_scores: {
              we_silent: sc.signals_v2?.sig_we_silent,
              client_silent: sc.signals_v2?.sig_client_silent,
              response_drop: sc.signals_v2?.sig_response_drop,
              volume_collapse: sc.signals_v2?.sig_volume_collapse,
              usage: sc.signals_v2?.sig_usage,
              billing: sc.signals_v2?.sig_billing,
            },
            flag_performance: sc.signals_v2?.flag_performance,
            flag_tickets: sc.signals_v2?.flag_tickets,
            reason_one_line: sc.signals_v2?.reason_one_line,
            suggested_action: sc.signals_v2?.suggested_action,
            lifecycle_state: sc.lifecycle_state,
            last_any_iso: sc.metrics?.last_any_iso,
            last_in_iso: sc.metrics?.last_in_iso,
            last_out_iso: sc.metrics?.last_out_iso,
            days_since_in: sc.metrics?.days_since_in,
            days_since_out: sc.metrics?.days_since_out,
            channels_used_30d: sc.metrics?.channels_used_30d,
            channels_used_90d: sc.metrics?.channels_used_90d,
            total_30d: sc.metrics?.total_30d,
            total_90d: sc.metrics?.total_90d,
            trajectory_7d: sc.signals_v2?.trajectory_7d,
          }
        : null,
      performance: perf
        ? {
            vertical: perf.identity.verticalDisplay ?? perf.identity.vertical,
            city: perf.identity.city,
            state: perf.identity.state,
            gbp_clicks_last_3_months: perf.gbpClicks
              .slice(-3)
              .map((m) => ({ month: m.month, clicks: m.profileClicks })),
            keywords_count: perf.keywords.length,
            keywords_top3: perf.keywords.filter(
              (k) => k.rankCurrent != null && k.rankCurrent > 0 && k.rankCurrent <= 3,
            ).length,
            keywords_top10: perf.keywords.filter(
              (k) => k.rankCurrent != null && k.rankCurrent > 0 && k.rankCurrent <= 10,
            ).length,
            leads_total: perf.leads.length,
            predicted_6_month_leads: perf.forecast?.predicted6MonthLeads ?? null,
            review_target: perf.forecast?.reviewTarget ?? null,
          }
        : null,
      escalations:
        escalations.length > 0
          ? {
              open: escalations
                .filter((t) =>
                  ["Todo", "In Progress", "In Review", "Backlog"].includes(t.state),
                )
                .slice(0, 8)
                .map((t) => ({
                  identifier: t.identifier,
                  title: t.title,
                  state: t.state,
                  classification: t.classification,
                  created_at: t.createdAt,
                })),
              closed_30d_count: escalations.filter((t) => {
                if (!["Done", "Canceled", "Duplicate"].includes(t.state)) return false;
                const c = t.completedAt || t.cancelledAt;
                if (!c) return false;
                const t0 = Date.parse(c);
                return Number.isFinite(t0) && Date.now() - t0 < 30 * 86_400_000;
              }).length,
            }
          : null,
      post_payment: postPayment
        ? {
            status: postPayment.status,
            verdict: postPayment.verdict,
            needs_am_call: postPayment.needs_am_call,
            verdict_one_line: postPayment.verdict_one_line,
            key_flags: postPayment.key_flags,
            booking_platform: postPayment.booking_platform,
            primary_category: postPayment.primary_category,
            predicted_6_month_leads: postPayment.predicted_6_month_leads,
            cb_created_at: postPayment.cb_created_at,
            updated_at: postPayment.updated_at,
          }
        : null,
    },
    null,
    2,
  );

  return {
    bizName: sc?.company ?? entityId,
    cbCustomerId: sc?.customer_id ?? null,
    blob,
  };
}

function systemPrompt(bizName: string, contextBlob: string): string {
  return `You are the Zoca Beacon copilot — an AI assistant embedded in Zoca's internal customer dashboard. Account managers and managers ask you questions about a specific customer; you ground every answer in the structured data below.

CUSTOMER: ${bizName}

CONTEXT (JSON):
${contextBlob}

OUTPUT RULES:
- Be concise. 2-4 sentences for simple questions; 4-6 short paragraphs max for complex ones.
- When you cite a number, name where it comes from in plain English ("their composite is X" / "GBP clicks dropped Y% vs peak" / "M-1 invoice is past due").
- NEVER invent data the context doesn't show. If the user asks something not covered, say so directly.
- For action-oriented asks ("draft an email", "what should I say"), produce the deliverable in full — don't preface it.
- Voice: pragmatic, AM-friendly, no corporate fluff or hedging. Use plain English. Match the directness of an internal Slack DM.
- Use Markdown formatting (lists, bold) sparingly and only when it genuinely helps scanning. Don't render headings (#).
- If verdict is RED or CRITICAL, lead with the single highest-leverage action.
- Sign off with one short suggested next step when relevant.`;
}

export async function POST(
  req: NextRequest,
  ctx: { params: { entity_id: string } },
) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const entityId = ctx.params.entity_id;
  if (!entityId) {
    return NextResponse.json({ error: "missing entity_id" }, { status: 400 });
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
  if (question.length > 2000) {
    return NextResponse.json(
      { error: "question too long (max 2000 chars)" },
      { status: 400 },
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 503 },
    );
  }

  // Trim history to MAX_HISTORY_TURNS most recent turns (a turn = one user
  // + one assistant pair), and ensure proper alternation.
  const history = Array.isArray(body.history) ? body.history : [];
  const trimmed = history.slice(-MAX_HISTORY_TURNS * 2);

  // Build customer context — happens server-side every request so the data
  // stays fresh and the client can't tamper.
  let bizName = entityId;
  let cbCustomerId: string | null = null;
  let contextBlob = "";
  try {
    const ctx = await buildCustomerContext(entityId);
    bizName = ctx.bizName;
    cbCustomerId = ctx.cbCustomerId;
    contextBlob = ctx.blob;
  } catch (e) {
    return NextResponse.json(
      { error: `couldn't load customer context: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  // Log telemetry (fire-and-forget — never block the streaming response).
  void logUmbrellaActivity({
    email,
    role: getRoleForEmail(email),
    am_name: session.user?.am_name ?? null,
    agent: "umbrella",
    event_name: "claude_asked",
    surface: "launcher",
    entity_id: entityId,
    metadata: {
      kind: "customer_360_ask",
      biz_name: bizName,
      cb_customer_id: cbCustomerId,
      question_length: question.length,
      history_turns: Math.floor(trimmed.length / 2),
    },
  });

  // Compose messages for Anthropic.
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...trimmed.map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, 4000),
    })),
    { role: "user", content: question },
  ];

  // Stream the response back as SSE.
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
          system: systemPrompt(bizName, contextBlob),
          messages,
        });

        sdkStream.on("text", (delta: string) => {
          send({ delta });
        });

        await sdkStream.finalMessage();
        send({ done: true });
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.error("[ask-claude] stream error", msg);
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
