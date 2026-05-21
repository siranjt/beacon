// GET /api/tickets
//
// Sources tickets from the Metabase public CSV (entity-joined Linear tickets).
//
//   ?classifications=Churn Ticket,Retention Risk Alert,Subscription Support Ticket,paid_user_offboarding,Subscription_Cancellation
//   ?states=Todo,In Progress,In Review,Done,Canceled,Duplicate
//   ?sinceDays=90      (default 0 = no time filter)
//   ?limit=200         (default 200)
//
// Sorted latest-first by createdAt.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  fetchTickets,
  ALL_CLASSIFICATIONS,
  type TicketClassification,
} from "@/lib/escalation/tickets";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  return session ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

const VALID_STATES = new Set([
  "Todo",
  "In Progress",
  "In Review",
  "Done",
  "Canceled",
  "Duplicate",
  "Backlog",
]);

export async function GET(req: NextRequest) {
  const authFail = await requireAuth();
  if (authFail) return authFail;

  const url = new URL(req.url);
  const classParam = (url.searchParams.get("classifications") || "").trim();
  const statesParam = (url.searchParams.get("states") || "").trim();
  const sinceDays = Number(url.searchParams.get("sinceDays") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "200");

  const classifications: TicketClassification[] = classParam
    ? (classParam
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is TicketClassification =>
          (ALL_CLASSIFICATIONS as readonly string[]).includes(s)
        ) as TicketClassification[])
    : [];

  const states = statesParam
    ? statesParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_STATES.has(s))
    : [];

  try {
    const tickets = await fetchTickets({
      classifications: classifications.length ? classifications : undefined,
      states: states.length ? states : undefined,
      sinceDays,
      limit,
    });

    const byClass: Record<string, number> = {};
    const byState: Record<string, number> = {};
    for (const t of tickets) {
      byClass[t.classification] = (byClass[t.classification] || 0) + 1;
      byState[t.state] = (byState[t.state] || 0) + 1;
    }

    return NextResponse.json({
      ok: true,
      tickets,
      stats: { total: tickets.length, byClassification: byClass, byState },
      sortedBy: "createdAt desc (latest first)",
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Internal error" },
      { status: 500 }
    );
  }
}
