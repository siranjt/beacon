/**
 * Negative Keyword Beacon — list open Linear retention-risk tickets.
 * Phase NK-3.4.
 *
 * GET /negative-keyword/api/tickets
 *
 * Returns retention-risk tickets in open states (Todo / In Progress /
 * In Review). Filter scope:
 *   - admin / manager → all tickets across the book
 *   - am → tickets assigned to them OR linked to a customer in their
 *          book (by AM-name match against the ticket assignee)
 *
 * Auth: session-gated (any role). The Created Tickets tab on the
 * dashboard hydrates from this endpoint.
 *
 * Soft-fail contract: if LINEAR_API_KEY is unset, returns an empty
 * tickets list with a notice so the UI renders an empty state instead
 * of an error.
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { listOpenRetentionTickets } from "@/lib/negative-keyword/tickets-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(_req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  const all = await listOpenRetentionTickets();

  // AM scope: keep only tickets where the assignee matches their
  // BaseSheet name. Managers + admins see the full list.
  const scoped =
    user.role === "am" && user.am_name
      ? all.filter(
          (t) =>
            t.am.trim().toLowerCase() === (user.am_name ?? "").trim().toLowerCase(),
        )
      : all;

  return NextResponse.json(
    {
      ok: true,
      tickets: scoped,
      total: scoped.length,
      scope: user.role === "am" ? "am" : "all",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
