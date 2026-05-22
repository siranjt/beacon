// Phase 33.E.1 — Metabase Customer Health card sync + getter.
//
// Pulls the 900-row health card from Metabase, normalizes each row, caches
// in Postgres. Read-time enrichment in /api/v2/snapshot reads from cache.
//
// CSV source — note: this is a Metabase public question, no auth needed.
//   https://metabase.zoca.ai/public/question/d6b7f180-2237-4514-af2a-b5edee76d029.csv

import { getSql } from "@/lib/customer/postgres";

const CSV_URL =
  "https://metabase.zoca.ai/public/question/d6b7f180-2237-4514-af2a-b5edee76d029.csv";

// --- Type the rows we care about (the rest live in JSONB.data untouched) ----

export type HealthTier =
  | "CRITICAL - DEAL BREAKER"
  | "AT-RISK"
  | "MONITOR"
  | "HEALTHY";

export interface NormalizedHealth {
  // Identifiers
  entity_id: string;

  // Core scoring
  composite_health_score: number | null;
  score_engagement: number | null;
  score_value_realization: number | null;
  score_product_stability: number | null;
  health_tier: HealthTier | null;
  health_tier_reason_names: string | null;
  health_tier_reason_details: string | null;
  recommended_action: string | null;

  // Alerts (deal-breakers + ops)
  alerts: {
    has_deal_breaker: boolean;
    payment_failed: boolean;
    oauth_revoked: boolean;
    website_down: boolean;
    gbp_unverified: boolean;
    zero_engagement: boolean;
    refund_given: boolean;
    win_low_booking_rate: boolean;
    open_churn_request: boolean;
    no_incoming_comms: boolean;
  };

  // Financial adjustments last 60d
  finance_60d: {
    has_refund: boolean;
    has_adjustment: boolean;
    has_promotion: boolean;
    has_credits_applied: boolean;
    refund_amount: number | null;
    adjustment_amount: number | null;
    discount_amount: number | null;
    credits_applied: number | null;
    refund_count_30d: number | null;
    refund_amount_30d: number | null;
  };

  // Engagement (Mixpanel-derived)
  engagement: {
    category: string | null;
    days_active_7d: number | null;
    days_active_14d: number | null;
    days_active_30d: number | null;
    days_since_last_activity: number | null;
    unique_features_used: number | null;
    total_app_opens: number | null;
    leads_viewed_pct: number | null;
    improvement_recommendation: string | null;
  };

  // Lead performance + prediction
  leads: {
    actual_30d: number | null;
    booked_30d: number | null;
    marked_30d: number | null;
    booking_conversion_rate: number | null;
    lead_marking_rate: number | null;
    predicted_6_month: number | null;
    expected_monthly: number | null;
  };

  // Product stability
  product: {
    has_active_oauth: boolean;
    is_gbp_verified: boolean;
    is_website_live: boolean;
    open_ticket_count: number | null;
    high_priority_tickets: number | null;
    oauth_score: number | null;
    gbp_score: number | null;
    website_score: number | null;
    ticket_score: number | null;
  };

  // Win Agent (booking automation, applies to ~2.8% of customers)
  win_agent: {
    enabled: boolean;
    total_leads_30d: number | null;
    booked_leads_30d: number | null;
    booking_rate_pct: number | null;
  };

  // Comms last-seen per channel (90d window)
  comms: {
    sms_count: number | null;
    last_sms_date: string | null;
    calls_count: number | null;
    last_call_date: string | null;
    chat_count: number | null;
    last_chat_date: string | null;
    email_count: number | null;
    last_email_date: string | null;
    total_incoming: number | null;
  };

  // Churn tickets
  churn: {
    open_count: number | null;
    ticket_ids: string | null;
    ticket_titles: string | null;
    latest_ticket_date: string | null;
  };

  // Raw row preserved for anything we forgot
  raw: Record<string, string>;
}

// ---------------------------------------------------------------------------

function parseBool(s: string | undefined): boolean {
  return (s || "").trim().toLowerCase() === "true";
}

function parseNum(s: string | undefined): number | null {
  if (!s || !s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseStr(s: string | undefined): string | null {
  const t = (s || "").trim();
  return t.length === 0 ? null : t;
}

function normalizeTier(s: string | undefined): HealthTier | null {
  const t = (s || "").trim().toUpperCase();
  if (t === "CRITICAL - DEAL BREAKER") return "CRITICAL - DEAL BREAKER";
  if (t === "AT-RISK") return "AT-RISK";
  if (t === "MONITOR") return "MONITOR";
  if (t === "HEALTHY") return "HEALTHY";
  return null;
}

// Minimal CSV parser — handles quoted fields with embedded commas. Inline so
// we don't take a dep on `papaparse` server-side. Field count varies; we use
// the header line to map by name, not position.
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // skip
      } else {
        field += c;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""))
    .map((r) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) obj[header[i]] = r[i] ?? "";
      return obj;
    });
}

export function normalizeRow(row: Record<string, string>): NormalizedHealth | null {
  const entity_id = (row["Entity ID"] || "").trim().toLowerCase();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(entity_id)) return null;

  return {
    entity_id,
    composite_health_score: parseNum(row["Composite Health Score"]),
    score_engagement: parseNum(row["Score Engagement"]),
    score_value_realization: parseNum(row["Score Value Realization"]),
    score_product_stability: parseNum(row["Score Product Stability"]),
    health_tier: normalizeTier(row["Health Tier"]),
    health_tier_reason_names: parseStr(row["Health Tier Reason Names"]),
    health_tier_reason_details: parseStr(row["Health Tier Reason Details"]),
    recommended_action: parseStr(row["Recommended Action"]),
    alerts: {
      has_deal_breaker: parseBool(row["Has Deal Breaker Alert"]),
      payment_failed: parseBool(row["Alert Payment Failed"]),
      oauth_revoked: parseBool(row["Alert Oauth Revoked"]),
      website_down: parseBool(row["Alert Website Down"]),
      gbp_unverified: parseBool(row["Alert Gbp Unverified"]),
      zero_engagement: parseBool(row["Alert Zero Engagement"]),
      refund_given: parseBool(row["Alert Refund Given"]),
      win_low_booking_rate: parseBool(row["Alert Win Low Booking Rate"]),
      open_churn_request: parseBool(row["Alert Open Churn Request"]),
      no_incoming_comms: parseBool(row["Alert No Incoming Comms"]),
    },
    finance_60d: {
      has_refund: parseBool(row["Has Refund 60d"]),
      has_adjustment: parseBool(row["Has Adjustment 60d"]),
      has_promotion: parseBool(row["Has Promotion 60d"]),
      has_credits_applied: parseBool(row["Has Credits Applied 60d"]),
      refund_amount: parseNum(row["Refund Amount 60d"]),
      adjustment_amount: parseNum(row["Adjustment Amount 60d"]),
      discount_amount: parseNum(row["Discount Amount 60d ($)"]),
      credits_applied: parseNum(row["Credits Applied 60d"]),
      refund_count_30d: parseNum(row["Refund Count 30d"]),
      refund_amount_30d: parseNum(row["Refund Amount 30d"]),
    },
    engagement: {
      category: parseStr(row["Engagement Category"]),
      days_active_7d: parseNum(row["Days Active 7d"]),
      days_active_14d: parseNum(row["Days Active 14d"]),
      days_active_30d: parseNum(row["Days Active 30d"]),
      days_since_last_activity: parseNum(row["Days Since Last Activity"]),
      unique_features_used: parseNum(row["Unique Features Used"]),
      total_app_opens: parseNum(row["Total App Opens"]),
      leads_viewed_pct: parseNum(row["Leads Viewed Pct"]),
      improvement_recommendation: parseStr(row["Improvement Recommendation"]),
    },
    leads: {
      actual_30d: parseNum(row["Actual Leads 30d"]),
      booked_30d: parseNum(row["Booked Leads 30d"]),
      marked_30d: parseNum(row["Marked Leads 30d"]),
      booking_conversion_rate: parseNum(row["Booking Conversion Rate"]),
      lead_marking_rate: parseNum(row["Lead Marking Rate"]),
      predicted_6_month: parseNum(row["Predicted 6 Month Leads"]),
      expected_monthly: parseNum(row["Expected Monthly Leads"]),
    },
    product: {
      has_active_oauth: parseBool(row["Has Active Oauth"]),
      is_gbp_verified: parseBool(row["Is Gbp Verified"]),
      is_website_live: parseBool(row["Is Website Live"]),
      open_ticket_count: parseNum(row["Open Ticket Count"]),
      high_priority_tickets: parseNum(row["High Priority Tickets"]),
      oauth_score: parseNum(row["Oauth Score"]),
      gbp_score: parseNum(row["Gbp Score"]),
      website_score: parseNum(row["Website Score"]),
      ticket_score: parseNum(row["Ticket Score"]),
    },
    win_agent: {
      enabled: parseBool(row["Has Win Agent"]),
      total_leads_30d: parseNum(row["Win Total Leads 30days"]),
      booked_leads_30d: parseNum(row["Win Booked Leads 30days"]),
      booking_rate_pct: parseNum(row["Win Booking Rate Pct"]),
    },
    comms: {
      sms_count: parseNum(row["Incoming Sms Count"]),
      last_sms_date: parseStr(row["Last Incoming Sms Date"]),
      calls_count: parseNum(row["Incoming Calls Count"]),
      last_call_date: parseStr(row["Last Incoming Call Date"]),
      chat_count: parseNum(row["Incoming Chat Count"]),
      last_chat_date: parseStr(row["Last Incoming Chat Date"]),
      email_count: parseNum(row["Incoming Email Count"]),
      last_email_date: parseStr(row["Last Incoming Email Date"]),
      total_incoming: parseNum(row["Total Incoming Comms"]),
    },
    churn: {
      open_count: parseNum(row["Open Churn Tickets"]),
      ticket_ids: parseStr(row["Churn Ticket Identifiers"]),
      ticket_titles: parseStr(row["Churn Ticket Titles"]),
      latest_ticket_date: parseStr(row["Latest Churn Ticket Date"]),
    },
    raw: row,
  };
}

// ---------------------------------------------------------------------------

export interface SyncStats {
  fetched: number;
  upserted: number;
  skipped_invalid_uuid: number;
  durationMs: number;
}

/**
 * Pull the latest CSV from Metabase, upsert each row keyed by entity_id.
 */
export async function syncHealthCard(): Promise<SyncStats> {
  const t0 = Date.now();
  const sql = getSql();
  if (!sql) throw new Error("[health-card] POSTGRES_URL not configured");

  const res = await fetch(CSV_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`[health-card] Metabase ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  const text = await res.text();
  const rows = parseCSV(text);

  const stats: SyncStats = {
    fetched: rows.length,
    upserted: 0,
    skipped_invalid_uuid: 0,
    durationMs: 0,
  };

  for (const r of rows) {
    const norm = normalizeRow(r);
    if (!norm) {
      stats.skipped_invalid_uuid++;
      continue;
    }
    await sql`
      INSERT INTO metabase_health_card_mapping (entity_id, data, synced_at)
      VALUES (${norm.entity_id}::uuid, ${JSON.stringify(norm)}::jsonb, NOW())
      ON CONFLICT (entity_id) DO UPDATE SET
        data      = EXCLUDED.data,
        synced_at = NOW()
    `;
    stats.upserted++;
  }

  stats.durationMs = Date.now() - t0;
  return stats;
}

/**
 * Returns Map<entity_id, NormalizedHealth> read from Postgres. Used by the
 * snapshot route to enrich each customer at READ time.
 */
export async function getHealthCardMap(): Promise<Map<string, NormalizedHealth>> {
  const sql = getSql();
  if (!sql) return new Map();
  const rows = await sql`
    SELECT entity_id::text AS entity_id, data
    FROM metabase_health_card_mapping
  `;
  const m = new Map<string, NormalizedHealth>();
  for (const r of rows as Array<{ entity_id: string; data: NormalizedHealth }>) {
    // Phase 33.E.1.2 — strip `raw` to keep the snapshot response under
    // Vercel's 4.5MB serverless function payload cap. The cached blob in
    // Postgres still has it; we just don't send it down to the client.
    const data = r.data as NormalizedHealth & { raw?: unknown };
    if (data && typeof data === "object" && "raw" in data) {
      const { raw: _omit, ...rest } = data;
      m.set(r.entity_id.toLowerCase(), rest as NormalizedHealth);
    } else {
      m.set(r.entity_id.toLowerCase(), data);
    }
  }
  return m;
}
