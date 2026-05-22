/**
 * Umbrella activity endpoint — Phase E-8.
 *
 * POST /api/activity
 *
 * Client-side endpoint for the umbrella useActivityLogger() hook. Logs UI
 * events (page_view, customer_opened, report_generated, ticket_opened, etc.)
 * keyed by the authenticated session. Used by Performance / Escalation /
 * Post-Payment. Customer Beacon retains its legacy /api/v2/activity route
 * (which writes through the same logUmbrellaActivity helper, just bound to
 * agent: 'customer' + the customer-only realtime Slack post).
 *
 * Auth: any signed-in zoca user. We deliberately do NOT require a customer-
 * beacon role here — most non-Customer agents have no role concept. The
 * NextAuth signIn callback already domain-gated the user.
 *
 * Body shape:
 *   {
 *     agent: "customer" | "performance" | "escalation" | "post-payment" | "umbrella",
 *     event_name: string,
 *     surface?: string,
 *     entity_id?: string,
 *     metadata?: Record<string, unknown>,
 *   }
 *
 * Returns: 204 No Content. Never blocks the UI.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logUmbrellaActivity } from "@/lib/activity/log";
import {
  ALL_EVENT_NAMES,
  ALL_SURFACES,
  isKnownAgent,
  type Agent,
} from "@/lib/activity/types";
import { getRoleForEmail } from "@/lib/customer/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ActivityBody {
  agent?: string;
  event_name?: string;
  surface?: string;
  entity_id?: string;
  metadata?: Record<string, unknown>;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: ActivityBody | null = null;
  try {
    body = (await req.json()) as ActivityBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { agent, event_name, surface, entity_id, metadata } = body || {};

  if (!agent || !isKnownAgent(agent)) {
    return NextResponse.json(
      { error: "agent required; must be one of customer|performance|escalation|post-payment|umbrella" },
      { status: 400 },
    );
  }
  if (!event_name || !ALL_EVENT_NAMES.includes(event_name)) {
    return NextResponse.json(
      { error: "event_name required and must be a known umbrella event" },
      { status: 400 },
    );
  }
  if (surface && !ALL_SURFACES.includes(surface)) {
    return NextResponse.json(
      { error: "surface must be a known surface" },
      { status: 400 },
    );
  }

  // Resolve the customer-beacon role + am_name from the session if applicable.
  // The umbrella logger accepts both as nullable, so it's fine to leave them
  // null for non-customer-beacon users.
  const role = getRoleForEmail(email);
  const am_name = session.user?.am_name ?? null;

  // Fire-and-forget; do not await — keep the endpoint snappy.
  void logUmbrellaActivity({
    email,
    role,
    am_name,
    agent: agent as Agent,
    event_name,
    surface: surface ?? null,
    entity_id: entity_id ?? null,
    metadata: metadata ?? null,
  });

  return new NextResponse(null, { status: 204 });
}
