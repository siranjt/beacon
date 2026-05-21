/**
 * Typed fetchers — one per data source. Each calls Metabase's Dataset API
 * with a single entity_id and returns the report-shaped object.
 *
 * No business logic here beyond row mapping + small derived fields
 * (vertical canonicalization, isGbpSourced flag). Heavier logic (signals,
 * aggregations across sections) lives in the signal engine and renderer.
 */

import { DB, runQuery } from "../metabase";
import {
  SQL_FORECAST,
  SQL_GBP_CLICKS_MONTHLY,
  SQL_KEYWORD_RANKINGS,
  SQL_LEADS,
  SQL_LOCATION,
} from "./queries";
import type {
  EntityReportData,
  Forecast,
  GbpMonthlyClicks,
  KeywordRanking,
  Lead,
  LocationIdentity,
} from "./types";
import { canonicalizeVertical } from "./vertical";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toNum = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const toStr = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return String(v);
};

const toBool = (v: unknown): boolean => {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  return false;
};

const isGbpUtm = (s: string | null) =>
  !!s && /googlemaps|googlemapsprofile|gbp|google_my_business/i.test(s);

// ---------------------------------------------------------------------------
// 1. Location identity
// ---------------------------------------------------------------------------

export async function fetchLocationIdentity(
  entityId: string
): Promise<LocationIdentity | null> {
  const rows = await runQuery<{
    entity_id: string;
    location_name: string;
    title: string;
    language_code: string | null;
    vertical_display: string | null;
    vertical_id: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    phone: string | null;
    place_id: string | null;
    maps_uri: string | null;
    status: string | null;
    website_uri: string | null;
    location_created_at: string | null;
  }>({
    database: DB.AURORA,
    sql: SQL_LOCATION,
    params: { entity_id: entityId },
  });
  if (!rows.length) return null;
  const r = rows[0];
  return {
    entityId: r.entity_id,
    locationName: r.location_name,
    title: r.title,
    verticalDisplay: r.vertical_display,
    vertical: canonicalizeVertical(r.vertical_display),
    city: r.city,
    state: r.state,
    country: r.country,
    phone: r.phone,
    websiteUri: r.website_uri,
    placeId: r.place_id,
    mapsUri: r.maps_uri,
    status: r.status,
    locationCreatedAt: r.location_created_at,
  };
}

// ---------------------------------------------------------------------------
// 2. GBP monthly clicks trend
// ---------------------------------------------------------------------------

export async function fetchGbpClicksMonthly(
  entityId: string
): Promise<GbpMonthlyClicks[]> {
  const rows = await runQuery<{
    month: string;
    profile_clicks: number;
    bookings: number;
    direction_requests: number;
    call_clicks: number;
  }>({
    database: DB.AURORA,
    sql: SQL_GBP_CLICKS_MONTHLY,
    params: { entity_id: entityId },
  });
  return rows.map((r) => ({
    month: r.month,
    profileClicks: toNum(r.profile_clicks) ?? 0,
    bookings: toNum(r.bookings) ?? 0,
    directionRequests: toNum(r.direction_requests) ?? 0,
    callClicks: toNum(r.call_clicks) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// 3. Keyword rankings
// ---------------------------------------------------------------------------

export async function fetchKeywordRankings(
  entityId: string
): Promise<KeywordRanking[]> {
  const rows = await runQuery<{
    keyword: string;
    rank_when_joined: number | null;
    rank_best: number | null;
    rank_current: number | null;
  }>({
    database: DB.AURORA,
    sql: SQL_KEYWORD_RANKINGS,
    params: { entity_id: entityId },
  });
  return rows.map((r) => ({
    keyword: r.keyword,
    rankWhenJoined: toNum(r.rank_when_joined),
    rankBest: toNum(r.rank_best),
    rankCurrent: toNum(r.rank_current),
  }));
}

// ---------------------------------------------------------------------------
// 4. Forecast
// ---------------------------------------------------------------------------

export async function fetchForecast(
  entityId: string
): Promise<Forecast | null> {
  const rows = await runQuery<{
    entity_id: string;
    generated_at: string;
    predicted_6_month_revenue: number | null;
    predicted_6_month_leads: number | null;
    review_target: number | null;
    percentage_change_profile_clicks: number | null;
    with_zoca_6_month_profile_clicks: number | null;
    without_zoca_6_month_profile_clicks: number | null;
    gbp_score: number | null;
    website_score: number | null;
    gbp_audit: unknown;
    monthly_predictions: unknown;
    metadata: unknown;
  }>({
    database: DB.AURORA,
    sql: SQL_FORECAST,
    params: { entity_id: entityId },
  });
  if (!rows.length) return null;
  const r = rows[0];
  return {
    entityId: r.entity_id,
    generatedAt: r.generated_at,
    predicted6MonthRevenue: toNum(r.predicted_6_month_revenue),
    predicted6MonthLeads: toNum(r.predicted_6_month_leads),
    reviewTarget: toNum(r.review_target),
    percentageChangeProfileClicks: toNum(r.percentage_change_profile_clicks),
    withZoca6MonthProfileClicks: toNum(r.with_zoca_6_month_profile_clicks),
    withoutZoca6MonthProfileClicks: toNum(r.without_zoca_6_month_profile_clicks),
    gbpScore: toNum(r.gbp_score),
    websiteScore: toNum(r.website_score),
    gbpAudit: r.gbp_audit,
    monthlyPredictions: r.monthly_predictions,
    metadata: r.metadata,
  };
}

// ---------------------------------------------------------------------------
// 5. Leads
// ---------------------------------------------------------------------------

export async function fetchLeads(entityId: string): Promise<Lead[]> {
  const rows = await runQuery<{
    id: string;
    created_at: string;
    status: string;
    source: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    service: string | null;
    service_variation_name: string | null;
    price: number | string | null;
    currency: string | null;
    is_l_to_b_active: boolean | null;
    booking_id: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    customer_type: string | null;
    first_message: string | null;
  }>({
    database: DB.POSTGRES,
    sql: SQL_LEADS,
    params: { entity_id: entityId },
  });
  return rows.map((r) => {
    const utmSource = toStr(r.utm_source);
    const utmMedium = toStr(r.utm_medium);
    const utmCampaign = toStr(r.utm_campaign);
    return {
      id: r.id,
      createdAt: r.created_at,
      status: r.status,
      source: toStr(r.source),
      utmSource,
      utmMedium,
      utmCampaign,
      isGbpSourced:
        isGbpUtm(utmSource) || isGbpUtm(utmMedium) || isGbpUtm(utmCampaign),
      service: toStr(r.service),
      serviceVariationName: toStr(r.service_variation_name),
      price: toNum(r.price),
      currency: toStr(r.currency),
      customerType:
        (toStr(r.customer_type)?.toLowerCase() as Lead["customerType"]) ?? null,
      firstName: toStr(r.first_name),
      lastName: toStr(r.last_name),
      email: toStr(r.email),
      phone: toStr(r.phone),
      firstMessage: toStr(r.first_message),
      bookingId: toStr(r.booking_id),
      isLeadToBookingActive: toBool(r.is_l_to_b_active),
    };
  });
}

// ---------------------------------------------------------------------------
// All-in-one: one entity, all data, run in parallel.
// ---------------------------------------------------------------------------

export async function fetchEntityReportData(
  entityId: string
): Promise<EntityReportData | null> {
  const [identity, gbpClicks, keywords, leads, forecast] = await Promise.all([
    fetchLocationIdentity(entityId),
    fetchGbpClicksMonthly(entityId),
    fetchKeywordRankings(entityId),
    fetchLeads(entityId),
    fetchForecast(entityId),
  ]);
  if (!identity) return null;
  return {
    identity,
    gbpClicks,
    keywords,
    leads,
    forecast,
    fetchedAt: new Date().toISOString(),
  };
}
