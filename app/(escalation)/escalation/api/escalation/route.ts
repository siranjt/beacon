// POST /api/escalation
//
// Two modes:
//   1. Stand-alone (no context): caller passes only { text, customerHint, source }
//      and the route runs buildContext itself — slow on cold start because
//      fetchCommsForEntity downloads 5 large CSVs.
//
//   2. Pre-fetched (Customer 360 path): caller passes { text, source, prefetched:
//      { customer, comms } }. We skip buildContext and synthesize a CustomerContext
//      from what the UI already has. This is the fast path used by the dashboard
//      after phase 2 of the lookup.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildContext } from "@/lib/escalation/enrichment";
import { runAgent } from "@/lib/escalation/agent";
import type { CustomerContext, EscalationInput, CommsMessage } from "@/lib/escalation/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  return session ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

interface PrefetchedCustomer {
  bizName?: string;
  entityId?: string;
  customerId?: string;
  email?: string;
  phone?: string;
  amName?: string;
  spName?: string;
  aeName?: string;
  status?: string;
  monthlyRevenue?: number;
}

interface IncomingBody extends EscalationInput {
  prefetched?: {
    customer?: PrefetchedCustomer;
    comms?: CommsMessage[];
  };
}

function buildContextFromPrefetched(p: NonNullable<IncomingBody["prefetched"]>): CustomerContext {
  const customer = p.customer || {};
  const comms = (p.comms || []).slice(0, 60); // cap for token economy
  // Sort newest first (matches what runAgent's prompt builder expects).
  comms.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  // Lightweight signals derivation (mirrors lib/enrichment#deriveSignals)
  const signals: string[] = [];
  const last30 = comms.filter((m) => Date.parse(m.createdAt) > Date.now() - 30 * 86400000);
  if (last30.length === 0) signals.push("No comms in the last 30 days");
  else signals.push(`${last30.length} message(s) across all channels in last 30 days`);
  const clientLast30 = last30.filter((m) => m.sender === "client").length;
  const teamLast30 = last30.filter((m) => m.sender === "team").length;
  if (clientLast30 > 5 && teamLast30 < clientLast30 / 2) {
    signals.push("Client outpacing team replies (possible neglect)");
  }

  return {
    customer: {
      customerId: customer.customerId,
      entityId: customer.entityId,
      bizName: customer.bizName,
      email: customer.email,
      phone: customer.phone,
      amName: customer.amName,
      spName: customer.spName,
      aeName: customer.aeName,
      status: customer.status,
      totalMonthlyRevenue: customer.monthlyRevenue,
    },
    subscription: undefined,
    unpaidInvoices: [],
    recentComms: comms,
    signals,
    lookupNotes: ["Triage built from pre-fetched UI context (Chargebee subscription/invoices not refetched)."],
  };
}

export async function POST(req: NextRequest) {
  const authFail = await requireAuth();
  if (authFail) return authFail;

  let body: IncomingBody;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.text || typeof body.text !== "string" || body.text.trim().length < 5) {
    return NextResponse.json(
      { ok: false, error: "Field `text` is required and must be at least 5 characters." },
      { status: 400 }
    );
  }

  try {
    let ctx: CustomerContext;
    if (body.prefetched && (body.prefetched.customer || body.prefetched.comms?.length)) {
      ctx = buildContextFromPrefetched(body.prefetched);
    } else {
      ctx = await buildContext(body);
    }
    const result = await runAgent(body, ctx);
    return NextResponse.json({
      ok: true,
      context: {
        customer: ctx.customer,
        subscription: ctx.subscription,
        unpaidInvoices: ctx.unpaidInvoices,
        signals: ctx.signals,
        commsCount: ctx.recentComms.length,
        lookupNotes: ctx.lookupNotes,
      },
      result,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Internal error" },
      { status: 500 }
    );
  }
}

export async function GET() {
  const authFail = await requireAuth();
  if (authFail) return authFail;
  return NextResponse.json({
    ok: true,
    description: "POST { text, customerHint?, source?, prefetched? } to triage an escalation.",
  });
}
