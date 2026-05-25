/**
 * Today's inbox — umbrella-wide action feed. Phase E-9.
 *
 * GET /api/inbox/today
 *
 * Aggregates "what needs your attention right now" across all four agents:
 *
 *   - Customer Beacon: RED-stoplight customers (silence, billing, signals)
 *   - Post-Payment: customers with `needs_am_call=true` and a landed verdict
 *   - Escalation: open Linear tickets (Todo / In Progress / In Review)
 *
 * Role-aware:
 *   - admin / manager / users with no customer-beacon role → see ALL items
 *   - am → filtered to their own book (customer.am_name === session.am_name)
 *
 * Each section returns:
 *   - count: total matching items in scope
 *   - items: top 5 by recency / severity for the feed UI
 *
 * Auth: any signed-in zoca user. Sections requiring customer-beacon role
 * data (RED customers) gracefully return `null` for the section instead of
 * failing the whole response if the snapshot can't be read.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { listCustomersSinceFloor } from "@/lib/post-payment/db/queries";
import { fetchAllTickets } from "@/lib/escalation/tickets";
import { getRoleForEmail } from "@/lib/customer/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface CriticalItem {
  entity_id: string;
  biz_name: string;
  am_name: string | null;
  cb_customer_id: string;
  composite: number;
  stoplight: "RED" | "YELLOW" | "GREEN";
  reason: string;
  suggested_action: string;
}

interface NeedsCallItem {
  cb_customer_id: string;
  biz_name: string;
  am_name: string | null;
  verdict: "icp" | "review" | "not_icp" | null;
  one_line: string;
  cb_created_at: string;
}

interface OpenTicketItem {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  customer_name: string;
  am_name: string;
  created_at: string;
  age_days: number;
}

interface InboxResponse {
  scope: {
    role: "admin" | "manager" | "am" | null;
    am_name: string | null;
    /** When true, sections are filtered to `am_name`'s book. */
    am_filtered: boolean;
  };
  critical_customers: {
    count: number;
    items: CriticalItem[];
  } | null;
  needs_am_call: {
    count: number;
    items: NeedsCallItem[];
  } | null;
  open_tickets: {
    count: number;
    items: OpenTicketItem[];
  } | null;
  generated_at: string;
  errors: Record<string, string>;
}

const SECTION_LIMIT = 5;

function ageDays(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const role = getRoleForEmail(email);
  const sessionAmName = session.user?.am_name ?? null;
  const amFiltered = role === "am" && !!sessionAmName;
  const errors: Record<string, string> = {};

  // Fetch all three sources in parallel. Each one's failure is isolated
  // so a single broken source doesn't blank the inbox.
  const [snapshotR, postPaymentR, ticketsR] = await Promise.allSettled([
    readLatestSnapshotV2(),
    listCustomersSinceFloor(),
    fetchAllTickets(),
  ]);

  // ---- Customer Beacon: RED-stoplight customers --------------------------
  let critical: InboxResponse["critical_customers"] = null;
  if (snapshotR.status === "fulfilled" && snapshotR.value) {
    const snap = snapshotR.value;
    const all = (snap.customers ?? []).filter((c) => {
      // Skip recently-churned customers — they're in retention mode, not
      // an active engagement signal.
      if (c.lifecycle_state === "recently_churned") return false;
      const stoplight = c.signals_v2?.stoplight;
      return stoplight === "RED";
    });
    const scoped = amFiltered
      ? all.filter((c) => (c.am_name || "") === sessionAmName)
      : all;

    // Highest composite first (worst customers surface at the top).
    scoped.sort(
      (a, b) =>
        (b.signals_v2?.composite ?? 0) - (a.signals_v2?.composite ?? 0),
    );

    critical = {
      count: scoped.length,
      items: scoped.slice(0, SECTION_LIMIT).map((c) => ({
        entity_id: c.entity_id,
        biz_name: c.company || c.entity_id,
        am_name: c.am_name ?? null,
        cb_customer_id: c.customer_id,
        composite: Math.round(c.signals_v2?.composite ?? 0),
        stoplight: c.signals_v2?.stoplight ?? "RED",
        reason: c.signals_v2?.reason_one_line ?? "Multiple at-risk signals",
        suggested_action:
          c.signals_v2?.suggested_action ?? "Contact this week",
      })),
    };
  } else if (snapshotR.status === "rejected") {
    errors.critical_customers =
      snapshotR.reason instanceof Error
        ? snapshotR.reason.message
        : String(snapshotR.reason);
  }

  // ---- Post-Payment: needs_am_call --------------------------------------
  let needsAmCall: InboxResponse["needs_am_call"] = null;
  if (postPaymentR.status === "fulfilled") {
    const all = postPaymentR.value.filter(
      (c) => c.needs_am_call && c.status === "ready" && c.verdict !== null,
    );
    const scoped = amFiltered
      ? all.filter((c) => (c.am_name || "") === sessionAmName)
      : all;

    // Newest first — fresh verdicts surface at the top.
    scoped.sort(
      (a, b) => Date.parse(b.cb_created_at) - Date.parse(a.cb_created_at),
    );

    needsAmCall = {
      count: scoped.length,
      items: scoped.slice(0, SECTION_LIMIT).map((c) => ({
        cb_customer_id: c.cb_customer_id,
        biz_name: c.biz_name || c.cb_customer_id,
        am_name: c.am_name ?? null,
        verdict: c.verdict,
        one_line: c.verdict_one_line ?? "Verdict requires AM follow-up",
        cb_created_at: c.cb_created_at,
      })),
    };
  } else {
    errors.needs_am_call =
      postPaymentR.reason instanceof Error
        ? postPaymentR.reason.message
        : String(postPaymentR.reason);
  }

  // ---- Escalation: open tickets -----------------------------------------
  let openTickets: InboxResponse["open_tickets"] = null;
  if (ticketsR.status === "fulfilled") {
    const OPEN_STATES = new Set(["Todo", "In Progress", "In Review", "Backlog"]);
    const all = ticketsR.value.filter((t) => OPEN_STATES.has(t.state));
    const scoped = amFiltered
      ? all.filter((t) => (t.amName || "") === sessionAmName)
      : all;

    // Newest first — recent tickets are most likely active threads.
    scoped.sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );

    openTickets = {
      count: scoped.length,
      items: scoped.slice(0, SECTION_LIMIT).map((t) => ({
        id: t.id,
        identifier: t.identifier || t.id.slice(0, 8),
        title: t.title || "(untitled)",
        url: t.url,
        state: t.state,
        customer_name: t.customerName || "—",
        am_name: t.amName || "—",
        created_at: t.createdAt,
        age_days: ageDays(t.createdAt),
      })),
    };
  } else {
    errors.open_tickets =
      ticketsR.reason instanceof Error
        ? ticketsR.reason.message
        : String(ticketsR.reason);
  }

  const body: InboxResponse = {
    scope: {
      role,
      am_name: sessionAmName,
      am_filtered: amFiltered,
    },
    critical_customers: critical,
    needs_am_call: needsAmCall,
    open_tickets: openTickets,
    generated_at: new Date().toISOString(),
    errors,
  };

  return NextResponse.json(body, {
    headers: {
      // Inbox is per-user-ish (AM filtering), but the underlying snapshot
      // + ticket cache already absorb most of the cost. 60-second browser
      // cache is plenty for a "today's queue" surface.
      "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
    },
  });
}
