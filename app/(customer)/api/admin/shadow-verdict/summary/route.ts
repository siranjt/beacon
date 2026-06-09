/**
 * Shadow verdict admin — daily summary.
 *
 * GET /api/admin/shadow-verdict/summary?date=YYYY-MM-DD
 *
 * Auth: manager + admin only.
 *
 * Returns:
 *   - run_date — date the data is for (today by default)
 *   - drift_histogram — counts at each drift severity (0=agree, 1=adjacent, 2=skip)
 *   - agreement_trend — last 28 days of agreement rate
 *   - stability — % of consecutive days where LLM verdict didn't change
 *   - feedback_aggregates — AM thumbs roll-up
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail, isManagerOrAdmin } from "@/lib/customer/config";
import {
  getAgreementTrend,
  getDriftHistogram,
  getFeedbackAggregates,
  getStabilityMetrics,
} from "@/lib/customer/shadow-verdict/repo";

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

  const [drift, trend, stability, feedback] = await Promise.all([
    getDriftHistogram(date),
    getAgreementTrend(28),
    getStabilityMetrics(14),
    getFeedbackAggregates(28),
  ]);

  return NextResponse.json(
    {
      run_date: date,
      drift_histogram: drift,
      agreement_trend: trend,
      stability,
      feedback_aggregates: feedback,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
