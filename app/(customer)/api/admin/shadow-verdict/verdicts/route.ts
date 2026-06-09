/**
 * Shadow verdict admin — verdicts list for a date.
 *
 * GET /api/admin/shadow-verdict/verdicts?date=YYYY-MM-DD&filter=disagree|all|llm-flagged
 *
 * Auth: manager + admin only.
 *
 * Defaults to today, "disagree" filter (the row that matters most).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail, isManagerOrAdmin } from "@/lib/customer/config";
import { listVerdictsForDate } from "@/lib/customer/shadow-verdict/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const role = getRoleForEmail(session.user.email);
  if (!isManagerOrAdmin(role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const filter = url.searchParams.get("filter") ?? "disagree";

  const all = await listVerdictsForDate(date, 2000);
  let rows = all;
  if (filter === "disagree") rows = all.filter((r) => !r.agreement);
  else if (filter === "llm-flagged") rows = all.filter((r) => r.llm_disagreement_self_flag);
  else if (filter === "skip") rows = all.filter((r) => r.drift_severity === 2);
  // "all" returns everything.

  return NextResponse.json(
    {
      run_date: date,
      filter,
      total: all.length,
      filtered: rows.length,
      rows,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
