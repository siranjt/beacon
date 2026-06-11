/**
 * get_customer_performance — Beacon AI tool. Phase F-ai-context L3c.
 *
 * Pulls the same data layer that drives the Performance Report
 * (zoca-performance-report → ported to lib/report/) for one customer.
 * Returns a single summary object covering:
 *   - GBP profile-click trend (peak / current / dip%, complete months only)
 *   - Top keyword rankings (active only, top-3 / top-10 / outside counts)
 *   - Leads YTD + recent (count, top utm_source)
 *   - Reviews snapshot from the forecast row (target/week + recent activity)
 *
 * No predictions / forecast values are exposed — per Zoca team direction,
 * `predicted_6_month_leads` is not customer-facing and must not leak through
 * Beacon AI either.
 *
 * READ-ONLY. No approval card. Audit-logged.
 */

import { fetchEntityReportData } from "@/lib/report/fetchers";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const MAX_KEYWORDS = 20;
const MAX_MONTHS = 12;

function describeGbpTrend(
  monthly: Array<{
    month: string;
    profileClicks: number;
  }>,
): {
  current_month: { month: string | null; clicks: number | null; partial: boolean };
  peak_month: { month: string; clicks: number } | null;
  dip_pct_from_peak: number | null;
  trailing_6m_total: number;
} {
  // Treat the latest month as in-progress; compute peak/dip on complete months.
  const sorted = [...monthly].sort((a, b) => a.month.localeCompare(b.month));
  const last = sorted[sorted.length - 1];
  const complete = sorted.slice(0, -1);
  let peak = null as { month: string; clicks: number } | null;
  for (const row of complete) {
    if (!peak || row.profileClicks > peak.clicks) {
      peak = { month: row.month, clicks: row.profileClicks };
    }
  }
  const currentClicks = last?.profileClicks ?? null;
  const dip =
    peak && currentClicks != null && peak.clicks > 0
      ? Math.round(((peak.clicks - currentClicks) / peak.clicks) * 100)
      : null;
  const trailing = complete.slice(-6).reduce((s, r) => s + r.profileClicks, 0);
  return {
    current_month: {
      month: last?.month ?? null,
      clicks: currentClicks,
      partial: true,
    },
    peak_month: peak,
    dip_pct_from_peak: dip,
    trailing_6m_total: trailing,
  };
}

export const getCustomerPerformanceTool: BeaconTool = {
  name: "get_customer_performance",
  description:
    "Pull a customer's marketing performance — GBP profile-click trend (complete months only), top 20 keyword rankings, lead-source mix, YTD leads, review target. Live Metabase pull, read-only. Predicted leads are internal-only and never surfaced.\n" +
    "Trigger phrases: \"how is Acme performing?\", \"has their GBP dropped?\", \"what keywords are they ranking for?\", \"how many leads YTD?\", \"are leads on track?\".",
  input_schema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description:
          "The customer's entity_id (UUID). Resolve via lookup_customer or from CONTEXT first.",
        minLength: 8,
      },
    },
    required: ["entity_id"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const entityId =
      typeof args.entity_id === "string" ? args.entity_id.trim() : "";
    if (!entityId) {
      return { ok: false, error: "entity_id is required" };
    }

    try {
      const data = await fetchEntityReportData(entityId);
      if (!data) {
        return {
          ok: true,
          summary: `No performance data found for entity ${entityId.slice(0, 8)} (Metabase didn't return a location row).`,
          data: { entity_id: entityId, found: false },
        };
      }

      const gbpTrend = describeGbpTrend(data.gbpClicks);
      const recentMonths = [...data.gbpClicks]
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(-MAX_MONTHS);

      const activeKeywords = data.keywords
        .filter((k) => (k as unknown as { isActive?: boolean }).isActive !== false)
        .slice(0, MAX_KEYWORDS);
      const top3 = activeKeywords.filter(
        (k) => typeof k.rankCurrent === "number" && k.rankCurrent > 0 && k.rankCurrent <= 3,
      ).length;
      const top10 = activeKeywords.filter(
        (k) => typeof k.rankCurrent === "number" && k.rankCurrent > 0 && k.rankCurrent <= 10,
      ).length;
      const ranked = activeKeywords.filter(
        (k) => typeof k.rankCurrent === "number" && k.rankCurrent > 0,
      ).length;

      const thisYear = new Date().getFullYear();
      const ytdLeads = data.leads.filter((l) => {
        const ts = l.createdAt ? Date.parse(l.createdAt) : NaN;
        return Number.isFinite(ts) && new Date(ts).getFullYear() === thisYear;
      });

      const sourceCounts = new Map<string, number>();
      for (const l of ytdLeads) {
        const src = (l.utmSource || "(unknown)").trim() || "(unknown)";
        sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
      }
      const topSources = Array.from(sourceCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([source, count]) => ({ source, count }));

      const result = {
        entity_id: entityId,
        found: true,
        location: {
          name: data.identity.locationName,
          city: data.identity.city,
          state: data.identity.state,
          vertical: data.identity.verticalDisplay,
          place_id: data.identity.placeId,
        },
        gbp_clicks_trend: gbpTrend,
        gbp_clicks_monthly: recentMonths.map((m) => ({
          month: m.month,
          profile_clicks: m.profileClicks,
          bookings: m.bookings,
          calls: m.callClicks,
        })),
        keywords: {
          active_count: activeKeywords.length,
          ranked_count: ranked,
          top_3_count: top3,
          top_10_count: top10,
          sample: activeKeywords.slice(0, 10).map((k) => ({
            keyword: k.keyword,
            rank_current: k.rankCurrent,
            rank_best: k.rankBest,
            rank_when_joined: k.rankWhenJoined,
          })),
        },
        leads: {
          ytd_count: ytdLeads.length,
          ytd_year: thisYear,
          top_sources: topSources,
        },
        reviews: {
          weekly_target:
            (data.forecast as unknown as { reviewTarget?: number | null })
              ?.reviewTarget ?? null,
        },
      };

      const summary =
        `${data.identity.locationName ?? "Customer"}: ` +
        `${gbpTrend.current_month.clicks ?? 0} GBP clicks this month` +
        (gbpTrend.peak_month
          ? ` (peak ${gbpTrend.peak_month.clicks} in ${gbpTrend.peak_month.month})`
          : "") +
        `, ${top3} top-3 / ${top10} top-10 keywords, ` +
        `${ytdLeads.length} YTD leads.`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:get_customer_performance",
        surface: "customer-360",
        entity_id: entityId,
        metadata: {
          tool: "get_customer_performance",
          gbp_current: gbpTrend.current_month.clicks,
          keywords_top10: top10,
          ytd_leads: ytdLeads.length,
        },
      });

      return { ok: true, summary, data: result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Performance fetch failed: ${msg}` };
    }
  },
};
