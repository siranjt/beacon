import Papa from "papaparse";
import {
  METABASE_V2_ENDPOINTS,
  USAGE_TIER_THRESHOLDS,
  USAGE_TIER_TO_SCORE,
  ZERO_MIXPANEL_BASELINE_SCORE,
} from "./config";
import type { UsageMetrics } from "./types";
import type { EngagementTier } from "./config";

/**
 * Mixpanel daily rollup CSV → per-entity UsageMetrics over 30-day windows.
 * Source: Metabase card 1 (b0809829...). Format: one row per
 * (entity_id, event_date, event_type). ~170K rows / 15 MB.
 */

type MixpanelRow = {
  entity_id: string;
  event_date: string;            // YYYY-MM-DD
  event_type: string;
  event_count: string;
  last_event_at: string;
};

// Event-type buckets — mirror canonical event list from design doc
const APP_OPEN_EVENTS = new Set(["App/Site Opened"]);
const SESSION_EVENTS = new Set(["$ae_session"]);
const LEADS_ENGAGE_EVENTS = new Set(["Leads-View-Home", "Leads-Click-Lead", "Leads-View-GetLeads"]);
const LEADS_MARKED_EVENTS = new Set(["Leads-Select-LeadStatusSheet"]);
const CONTACT_ATTEMPT_EVENTS = new Set([
  "Leads-Click-LeadContact",
  "Leads-Click-ChatCall",
  "Leads-Click-DetailCopyNumber",
]);
const REVIEW_ACTION_EVENTS = new Set([
  "Reviews-Click-ReviewReplyAI",
  "Reviews-Done-ReviewReply",
  "Review-Click-SendInviteSingle",
]);

const DAY_MS = 86400 * 1000;

async function fetchCsvText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", cache: "no-store", headers: { Accept: "text/csv" } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mixpanel CSV ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.text();
}

function parseRows<T>(csv: string): T[] {
  const out = Papa.parse<T>(csv, { header: true, skipEmptyLines: true });
  return (out.data || []).filter((r) => r && typeof r === "object");
}

function deriveTier(distinctAppOpenDays30d: number, daysSinceLast: number): EngagementTier {
  if (daysSinceLast >= 30) return "Dormant";
  if (distinctAppOpenDays30d >= USAGE_TIER_THRESHOLDS.activeDistinctDaysMin) return "Active";
  if (distinctAppOpenDays30d >= USAGE_TIER_THRESHOLDS.lightDistinctDaysMin) return "Light";
  if (distinctAppOpenDays30d >= 1) return "Cold";
  // No app opens in 30d but possibly other events
  if (daysSinceLast < 14) return "Cold";
  return "Dormant";
}

/**
 * Fetch + parse Mixpanel rollup CSV, return per-entity usage metrics.
 *
 * @param todayMs Anchor for window math (Date.now() in production)
 */
export async function fetchUsageMetrics(todayMs: number): Promise<{
  metrics: Map<string, UsageMetrics>;
  rowCount: number;
}> {
  const csv = await fetchCsvText(METABASE_V2_ENDPOINTS.mixpanelRollup);

  // Per-entity aggregation. Stream-parse the CSV row-by-row so the full 168K-row
  // array is never held in memory. Saves ~50MB peak vs the previous buffered approach.
  const byEntity = new Map<string, {
    total7d: number; total30d: number; total90d: number;
    eventDays30d: Set<string>;
    appOpenDays30d: Set<string>;
    appOpens30d: number;
    leadsEngage30d: number;
    leadsMarked30d: number;
    contactAttempts30d: number;
    reviewActions30d: number;
    lastEventAt: string | null;
  }>();

  const todayDate = new Date(todayMs).toISOString().slice(0, 10);
  const cutoff7 = todayMs - 7 * DAY_MS;
  const cutoff30 = todayMs - 30 * DAY_MS;
  const cutoff90 = todayMs - 90 * DAY_MS;

  // Manual line-by-line CSV walk. Papa.parse step callback was buffering
  // internally on 15MB CSVs and OOMing on the Hobby tier; this avoids any
  // library overhead. Mixpanel rollup has 5 columns with no embedded commas.
  let rowCount = 0;
  const headerEnd = csv.indexOf("\n");
  const headerCols = csv.slice(0, headerEnd).split(",");
  const colEid = headerCols.indexOf("entity_id");
  const colDate = headerCols.indexOf("event_date");
  const colEvent = headerCols.indexOf("event_type");
  const colCount = headerCols.indexOf("event_count");
  const colLast = headerCols.indexOf("last_event_at");
  if (colEid < 0 || colDate < 0 || colEvent < 0 || colCount < 0) {
    throw new Error("Mixpanel CSV missing expected columns; got: " + headerCols.join(","));
  }

  let pos = headerEnd + 1;
  const csvLen = csv.length;
  while (pos < csvLen) {
    let lineEnd = csv.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = csvLen;
    const line = csv.slice(pos, lineEnd);
    pos = lineEnd + 1;
    if (!line) continue;
    rowCount++;

    const cols = line.split(",");
    const eid = (cols[colEid] || "").trim();
    if (!eid) continue;
    const eventDate = cols[colDate] || "";
    const ts = Date.parse(eventDate + "T12:00:00Z");
    if (!Number.isFinite(ts)) continue;
    const ev = cols[colEvent] || "";
    const cnt = Number(cols[colCount] || 0);
    const lastEventAt = colLast >= 0 ? (cols[colLast] || "") : "";

    let agg = byEntity.get(eid);
    if (!agg) {
      agg = {
        total7d: 0, total30d: 0, total90d: 0,
        eventDays30d: new Set(),
        appOpenDays30d: new Set(),
        appOpens30d: 0,
        leadsEngage30d: 0,
        leadsMarked30d: 0,
        contactAttempts30d: 0,
        reviewActions30d: 0,
        lastEventAt: null,
      };
      byEntity.set(eid, agg);
    }

    if (!agg.lastEventAt || (lastEventAt && lastEventAt > agg.lastEventAt)) {
      agg.lastEventAt = lastEventAt;
    }

    if (ts >= cutoff90) agg.total90d += cnt;
    if (ts >= cutoff30) {
      agg.total30d += cnt;
      agg.eventDays30d.add(eventDate);
      if (APP_OPEN_EVENTS.has(ev)) {
        agg.appOpens30d += cnt;
        agg.appOpenDays30d.add(eventDate);
      }
      if (LEADS_ENGAGE_EVENTS.has(ev)) agg.leadsEngage30d += cnt;
      if (LEADS_MARKED_EVENTS.has(ev)) agg.leadsMarked30d += cnt;
      if (CONTACT_ATTEMPT_EVENTS.has(ev)) agg.contactAttempts30d += cnt;
      if (REVIEW_ACTION_EVENTS.has(ev)) agg.reviewActions30d += cnt;
    }
    if (ts >= cutoff7) agg.total7d += cnt;
    void SESSION_EVENTS;
  }

  // Convert to UsageMetrics
  const metrics = new Map<string, UsageMetrics>();
  for (const [eid, agg] of byEntity) {
    const lastIso = agg.lastEventAt ? new Date(Date.parse(agg.lastEventAt)).toISOString() : null;
    const daysSinceLast = lastIso === null
      ? 9999
      : Math.max(0, Math.floor((todayMs - Date.parse(lastIso)) / DAY_MS));
    const tier = deriveTier(agg.appOpenDays30d.size, daysSinceLast);
    metrics.set(eid, {
      entity_id: eid,
      total_events_7d: agg.total7d,
      total_events_30d: agg.total30d,
      total_events_90d: agg.total90d,
      distinct_event_days_30d: agg.eventDays30d.size,
      distinct_app_open_days_30d: agg.appOpenDays30d.size,
      app_opens_30d: agg.appOpens30d,
      leads_engagement_30d: agg.leadsEngage30d,
      leads_marked_30d: agg.leadsMarked30d,
      contact_attempts_30d: agg.contactAttempts30d,
      review_actions_30d: agg.reviewActions30d,
      last_event_at: lastIso,
      days_since_last_event: daysSinceLast,
      engagement_tier: tier,
    });
  }

  console.log(
    "[fetchUsageMetrics] entities:", metrics.size,
    "rows parsed:", rowCount,
    "today anchor:", todayDate,
  );
  return { metrics, rowCount };
}

/**
 * Map usage metrics → 0-100 risk score for the composite.
 * Tier-based with refinements for missing data and engagement collapse.
 */
export function scoreUsage(m: UsageMetrics | null): number {
  if (!m) return ZERO_MIXPANEL_BASELINE_SCORE;
  // Base from engagement tier
  let score = USAGE_TIER_TO_SCORE[m.engagement_tier];
  // Refinements: if app opens collapsed but other events exist, dampen slightly
  if (m.engagement_tier === "Dormant" && m.total_events_30d > 0) score -= 10;
  // If recent flurry of activity, soften further
  if (m.days_since_last_event <= 1 && m.total_events_7d >= 5) score = Math.min(score, 25);
  return Math.max(0, Math.min(100, Math.round(score)));
}
