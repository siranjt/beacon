import { NextRequest, NextResponse } from "next/server";
import { readLatestSnapshotV2, readSnapshotByDate, readPendingFollowUps } from "@/lib/customer/postgres";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import { getApiUser, requireAmScope } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/am/:amName/monday-brief
 *   → AM weekly briefing data: top RED to call, customers degraded since
 *     last week, customers improving since last week, scheduled follow-ups
 *     for the next 7 days.
 *
 * Phase 33.B — admin + manager bypass; AMs must request their own am_name.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: { amName: string } },
) {
  const user = await getApiUser();
  const am = decodeURIComponent(ctx.params.amName);
  const denied = requireAmScope(user, am);
  if (denied) return denied;

  try {
    const [latest, followUps] = await Promise.all([
      readLatestSnapshotV2(),
      readPendingFollowUps(am, 7),
    ]);
    if (!latest) {
      return NextResponse.json({ error: "no snapshot available" }, { status: 404 });
    }

    // Filter to this AM's book
    const book = latest.customers.filter((c) => c.am_name === am);

    // Top 5 customers needing call (Critical + At-risk), sorted by composite desc, exclude pre-launch
    const topRed = book
      .filter(
        (c) =>
          (["CRITICAL - DEAL BREAKER", "CRITICAL", "AT-RISK"].includes(String(((c as any).metabase_health?.health_tier) || ""))) &&
          !c.signals_v2.pre_launch,
      )
      .sort((a, b) => b.signals_v2.composite - a.signals_v2.composite)
      .slice(0, 5);

    // Compare to 7d-ago snapshot for "degraded" / "improving" lists
    const sevenDaysAgo = new Date(latest.generatedAt);
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
    const ymd = sevenDaysAgo.toISOString().slice(0, 10);
    const prev = await readSnapshotByDate(ymd);
    let degradedThisWeek: ScoredCustomerV2[] = [];
    let improvedThisWeek: ScoredCustomerV2[] = [];
    if (prev) {
      const prevByEntity = new Map<string, string>();
      for (const c of prev.customers) {
        prevByEntity.set(c.entity_id, c.signals_v2.stoplight);
      }
      degradedThisWeek = book.filter((c) => {
        const prevSl = prevByEntity.get(c.entity_id);
        const curSl = c.signals_v2.stoplight;
        // Worse direction: GREEN→YELLOW, GREEN→RED, YELLOW→RED
        if (prevSl === "GREEN" && (curSl === "YELLOW" || curSl === "RED")) return true;
        if (prevSl === "YELLOW" && curSl === "RED") return true;
        return false;
      });
      improvedThisWeek = book.filter((c) => {
        const prevSl = prevByEntity.get(c.entity_id);
        const curSl = c.signals_v2.stoplight;
        if (prevSl === "RED" && (curSl === "YELLOW" || curSl === "GREEN")) return true;
        if (prevSl === "YELLOW" && curSl === "GREEN") return true;
        return false;
      });
    }

    // Aggregate book-level stats
    const totals = book.reduce(
      (acc, c) => {
        // Phase 33.scope followup — exclude recently_churned from tier tallies.
        // (Spec leaves room to add them to a separate MRR bucket later, but the
        // current reducer only tracks mrrAtRisk, which they cannot contribute
        // to once their tier is no longer CRITICAL/AT-RISK.)
        if ((c as any).lifecycle_state === "recently_churned") return acc;
        // Phase 33.H.5 — repurpose totals.RED/YELLOW/GREEN to count tiers (MONITOR fallback)
        const _htRaw = ((c as any).metabase_health?.health_tier as string | null | undefined) || "";
        const _ht =
          _htRaw === "CRITICAL - DEAL BREAKER" || _htRaw === "CRITICAL" ? "CRITICAL"
          : _htRaw === "AT-RISK" ? "AT-RISK"
          : _htRaw === "HEALTHY" ? "HEALTHY"
          : "MONITOR";
        if (_ht === "CRITICAL" || _ht === "AT-RISK") acc.RED += 1;
        else if (_ht === "MONITOR") acc.YELLOW += 1;
        else acc.GREEN += 1;
        if (c.signals_v2.pre_launch) acc.preLaunch += 1;
        if (_ht === "CRITICAL" || _ht === "AT-RISK") acc.mrrAtRisk += c.plan_amount || 0;
        return acc;
      },
      { RED: 0, YELLOW: 0, GREEN: 0, preLaunch: 0, mrrAtRisk: 0 },
    );

    return NextResponse.json(
      {
        am_name: am,
        snapshot_date: latest.generatedAt.slice(0, 10),
        compared_to: prev ? prev.generatedAt.slice(0, 10) : null,
        book_size: book.length,
        totals,
        top_red: topRed,
        degraded_this_week: degradedThisWeek,
        improved_this_week: improvedThisWeek,
        follow_ups: followUps,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
