import Papa from "papaparse";
import {
  METABASE_V2_ENDPOINTS,
  PERFORMANCE_FLAG_THRESHOLDS,
} from "./config";
import type {
  GbpClicksMonthRow,
  RankingsRow,
  Reviews12wRow,
  LocationInsightsRow,
  BookingEnquiriesRow,
  PerformanceMetrics,
} from "./types";

/**
 * Fetch the 5 performance-related Metabase cards in parallel, then derive
 * one PerformanceMetrics row per entity_id with the trajectory-flag verdict.
 *
 * Card 2: GBP clicks per (entity, month) — last 7 months
 * Card 3: Rankings distribution per entity
 * Card 4: Reviews 12-week activity per entity
 * Card 5: Location insights (latest valid row per entity)
 * Card 6: Booking enquiries YTD vs prior YTD per entity
 */

async function fetchCsvText(url: string, name: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", cache: "no-store", headers: { Accept: "text/csv" } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${name} CSV ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.text();
}

function parseRows<T>(csv: string): T[] {
  const out = Papa.parse<T>(csv, { header: true, skipEmptyLines: true });
  return (out.data || []).filter((r) => r && typeof r === "object");
}

function num(s: string | undefined): number | null {
  if (s === undefined || s === null || s === "") return null;
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseBool(s: string | undefined): boolean {
  return String(s || "").trim().toLowerCase() === "true";
}

// ---------------------------------------------------------------------------
// Per-card parsers
// ---------------------------------------------------------------------------

async function parseGbpClicksMonthly(): Promise<GbpClicksMonthRow[]> {
  const csv = await fetchCsvText(METABASE_V2_ENDPOINTS.gbpClicksMonthly, "GBP clicks");
  type R = { entity_id: string; month_start: string; profile_clicks: string; last_day_in_month: string; is_complete_month: string };
  const rows = parseRows<R>(csv);
  return rows.map((r) => ({
    entity_id: (r.entity_id || "").trim(),
    month_start: r.month_start,
    profile_clicks: num(r.profile_clicks) || 0,
    last_day_in_month: r.last_day_in_month,
    is_complete_month: parseBool(r.is_complete_month),
  })).filter((r) => r.entity_id);
}

async function parseRankings(): Promise<Map<string, RankingsRow>> {
  const csv = await fetchCsvText(METABASE_V2_ENDPOINTS.rankings, "Rankings");
  type R = { entity_id: string; active_ranking_count: string; rankings_top_3: string; rankings_top_10: string; rankings_outside_10: string };
  const rows = parseRows<R>(csv);
  const m = new Map<string, RankingsRow>();
  for (const r of rows) {
    const eid = (r.entity_id || "").trim();
    if (!eid) continue;
    m.set(eid, {
      entity_id: eid,
      active_ranking_count: num(r.active_ranking_count) || 0,
      rankings_top_3: num(r.rankings_top_3) || 0,
      rankings_top_10: num(r.rankings_top_10) || 0,
      rankings_outside_10: num(r.rankings_outside_10) || 0,
    });
  }
  return m;
}

async function parseReviews12w(): Promise<Map<string, Reviews12wRow>> {
  const csv = await fetchCsvText(METABASE_V2_ENDPOINTS.reviews12w, "Reviews 12w");
  type R = { entity_id: string; reviews_last_12_weeks_total: string; weeks_with_zero_reviews: string };
  const rows = parseRows<R>(csv);
  const m = new Map<string, Reviews12wRow>();
  for (const r of rows) {
    const eid = (r.entity_id || "").trim();
    if (!eid) continue;
    m.set(eid, {
      entity_id: eid,
      reviews_last_12_weeks_total: num(r.reviews_last_12_weeks_total) || 0,
      weeks_with_zero_reviews: num(r.weeks_with_zero_reviews) || 0,
    });
  }
  return m;
}

async function parseLocationInsights(): Promise<Map<string, LocationInsightsRow>> {
  const csv = await fetchCsvText(METABASE_V2_ENDPOINTS.locationInsights, "Location insights");
  type R = { entity_id: string; review_target_weekly: string; with_zoca_6_month_profile_clicks: string; insights_generated_at: string };
  const rows = parseRows<R>(csv);
  const m = new Map<string, LocationInsightsRow>();
  for (const r of rows) {
    const eid = (r.entity_id || "").trim();
    if (!eid) continue;
    m.set(eid, {
      entity_id: eid,
      review_target_weekly: num(r.review_target_weekly) || 0,
      with_zoca_6_month_profile_clicks: num(r.with_zoca_6_month_profile_clicks) || 0,
      insights_generated_at: r.insights_generated_at || "",
    });
  }
  return m;
}

async function parseBookingEnquiries(): Promise<Map<string, BookingEnquiriesRow>> {
  const csv = await fetchCsvText(METABASE_V2_ENDPOINTS.bookingEnquiries, "Booking enquiries");
  type R = { entity_id: string; ytd_leads: string; prior_ytd_leads: string };
  const rows = parseRows<R>(csv);
  const m = new Map<string, BookingEnquiriesRow>();
  for (const r of rows) {
    const eid = (r.entity_id || "").trim();
    if (!eid) continue;
    m.set(eid, {
      entity_id: eid,
      ytd_leads: num(r.ytd_leads) || 0,
      prior_ytd_leads: num(r.prior_ytd_leads) || 0,
    });
  }
  return m;
}

// ---------------------------------------------------------------------------
// GBP clicks derivation: peak / current-complete / in-progress / drop %
// ---------------------------------------------------------------------------

function deriveGbpByEntity(rows: GbpClicksMonthRow[]): Map<string, {
  peak: number;
  current: number;
  inProgress: number;
  dropPct: number | null;
}> {
  const grouped = new Map<string, GbpClicksMonthRow[]>();
  for (const r of rows) {
    const arr = grouped.get(r.entity_id) || [];
    arr.push(r);
    grouped.set(r.entity_id, arr);
  }
  const out = new Map<string, { peak: number; current: number; inProgress: number; dropPct: number | null }>();
  for (const [eid, list] of grouped) {
    const complete = list.filter((r) => r.is_complete_month).sort((a, b) => a.month_start.localeCompare(b.month_start));
    const inProgressRow = list.find((r) => !r.is_complete_month);
    const peak = complete.length ? Math.max(...complete.map((r) => r.profile_clicks)) : 0;
    const current = complete.length ? complete[complete.length - 1].profile_clicks : 0;
    const inProgress = inProgressRow ? inProgressRow.profile_clicks : 0;
    const dropPct = peak > 0 ? ((peak - current) / peak) * 100 : null;
    out.set(eid, { peak, current, inProgress, dropPct });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compose per-entity performance metrics + flag
// ---------------------------------------------------------------------------

export async function fetchPerformanceMetrics(): Promise<{
  metrics: Map<string, PerformanceMetrics>;
  rowCounts: {
    gbpClicksMonthly: number;
    rankings: number;
    reviews12w: number;
    locationInsights: number;
    bookingEnquiries: number;
  };
}> {
  // Pull all 5 cards in parallel
  const [gbpRows, rankings, reviews, insights, leads] = await Promise.all([
    parseGbpClicksMonthly(),
    parseRankings(),
    parseReviews12w(),
    parseLocationInsights(),
    parseBookingEnquiries(),
  ]);

  const gbpByEntity = deriveGbpByEntity(gbpRows);

  // Union of entity_ids across all sources
  const allEntities = new Set<string>();
  for (const eid of gbpByEntity.keys()) allEntities.add(eid);
  for (const eid of rankings.keys()) allEntities.add(eid);
  for (const eid of reviews.keys()) allEntities.add(eid);
  for (const eid of insights.keys()) allEntities.add(eid);
  for (const eid of leads.keys()) allEntities.add(eid);

  const metrics = new Map<string, PerformanceMetrics>();
  for (const eid of allEntities) {
    const gbp = gbpByEntity.get(eid);
    const rnk = rankings.get(eid);
    const rev = reviews.get(eid);
    const ins = insights.get(eid);
    const lds = leads.get(eid);

    const ytdChangePct = (lds && lds.prior_ytd_leads > 0)
      ? ((lds.ytd_leads - lds.prior_ytd_leads) / lds.prior_ytd_leads) * 100
      : null;

    // Trajectory flag triggers
    const flagReasons: string[] = [];
    if (gbp && gbp.dropPct !== null && gbp.dropPct >= PERFORMANCE_FLAG_THRESHOLDS.gbpClicksDropPctMin) {
      flagReasons.push(`GBP clicks down ${Math.round(gbp.dropPct)}%`);
    }
    if (ytdChangePct !== null && ytdChangePct <= -PERFORMANCE_FLAG_THRESHOLDS.ytdLeadsDropPctMin) {
      flagReasons.push(`YTD leads ${Math.round(ytdChangePct)}% vs last year`);
    }
    if (
      rev &&
      rev.weeks_with_zero_reviews !== null &&
      rev.weeks_with_zero_reviews >= PERFORMANCE_FLAG_THRESHOLDS.weeksWithZeroReviewsMin
    ) {
      flagReasons.push(`${rev.weeks_with_zero_reviews}/12 weeks with zero reviews`);
    }

    metrics.set(eid, {
      entity_id: eid,
      gbp_clicks_peak_complete_month: gbp?.peak ?? null,
      gbp_clicks_current_complete_month: gbp?.current ?? null,
      gbp_clicks_in_progress_month: gbp?.inProgress ?? null,
      gbp_clicks_drop_pct: gbp?.dropPct ?? null,
      ytd_leads: lds?.ytd_leads ?? null,
      prior_ytd_leads: lds?.prior_ytd_leads ?? null,
      ytd_leads_change_pct: ytdChangePct,
      active_ranking_count: rnk?.active_ranking_count ?? null,
      rankings_top_3: rnk?.rankings_top_3 ?? null,
      rankings_top_10: rnk?.rankings_top_10 ?? null,
      rankings_outside_10: rnk?.rankings_outside_10 ?? null,
      reviews_last_12_weeks_total: rev?.reviews_last_12_weeks_total ?? null,
      weeks_with_zero_reviews: rev?.weeks_with_zero_reviews ?? null,
      review_target_weekly: ins?.review_target_weekly ?? null,
      flag: flagReasons.length > 0,
      flag_reasons: flagReasons,
    });
  }

  const rowCounts = {
    gbpClicksMonthly: gbpRows.length,
    rankings: rankings.size,
    reviews12w: reviews.size,
    locationInsights: insights.size,
    bookingEnquiries: leads.size,
  };
  console.log("[fetchPerformanceMetrics] entities:", metrics.size, "card rows:", rowCounts);
  return { metrics, rowCounts };
}

/**
 * Compute the performance-trajectory modifier flag for a single entity.
 * Returns whether the flag is set + a human-readable reason list.
 */
