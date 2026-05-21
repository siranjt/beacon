import { NextRequest, NextResponse } from "next/server";
import { buildContext } from "@/lib/escalation/enrichment";
import { runAgent } from "@/lib/escalation/agent";
import type { EscalationInput } from "@/lib/escalation/types";

export const runtime = "nodejs";
export const maxDuration = 60;

// Generic webhook receiver. Map common shapes (Slack-style, email JSON, etc.)
// into an EscalationInput. Anything we can't recognize falls back to using
// the raw stringified body as the text.
function normalize(body: any): EscalationInput {
  // Slack Events API event_callback
  if (body?.event?.text && body?.event?.type) {
    return {
      text: String(body.event.text),
      source: {
        medium: "slack",
        channelOrThread: body.event.channel || body.event.channel_id,
        receivedAt: body.event.ts ? new Date(Number(body.event.ts) * 1000).toISOString() : undefined,
      },
      customerHint: body.event.user_email ? { email: String(body.event.user_email) } : undefined,
    };
  }

  // Generic { text, email?, customerId?, entityId?, source? }
  if (typeof body?.text === "string") {
    return {
      text: body.text,
      customerHint: {
        email: body.email,
        customerId: body.customerId,
        entityId: body.entityId,
        bizName: body.bizName,
      },
      source: body.source || { medium: "webhook" },
    };
  }

  // Last resort
  return {
    text: typeof body === "string" ? body : JSON.stringify(body).slice(0, 4000),
    source: { medium: "webhook" },
  };
}

export async function POST(req: NextRequest) {
  // Optional shared-secret check
  const requiredSecret = process.env.WEBHOOK_SHARED_SECRET || "";
  if (requiredSecret) {
    const got = req.headers.get("x-zoca-webhook-secret") || "";
    if (got !== requiredSecret) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = await req.text();
  }

  // Slack URL verification handshake
  if (body?.type === "url_verification" && typeof body.challenge === "string") {
    return NextResponse.json({ challenge: body.challenge });
  }

  const input = normalize(body);
  if (!input.text || input.text.trim().length < 5) {
    return NextResponse.json({ error: "No usable text in webhook body" }, { status: 400 });
  }

  try {
    const ctx = await buildContext(input);
    const result = await runAgent(input, ctx);
    return NextResponse.json({ ok: true, result, signals: ctx.signals });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Internal error" }, { status: 500 });
  }
}
