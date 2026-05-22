// Phase 33.C — Usage analytics queries.
//
// Six aggregates that power /admin/usage. All read from am_activity_log,
// all bounded by time windows, all return plain objects (no JSONB nesting
// passed up to the client).

import { getSql } from "@/lib/customer/postgres";

export interface UsageSummary {
  dau: number;
  wau: number;
  mau: number;
  total_events_7d: number;
  total_sign_ins_7d: number;
}

export interface DailyActivityRow {
  date: string;        // ISO date (YYYY-MM-DD)
  events: number;
  unique_users: number;
}

export interface PerUserRow {
  email: string;
  role: "admin" | "manager" | "am";
  am_name: string | null;
  last_active: string;     // ISO timestamp
  sign_ins: number;
  total_events: number;
  customer_opens: number;
  pages_viewed: number;
  actions_taken: number;
  filter_changes: number;
}

export interface TopPathRow {
  path: string;
  hits: number;
  unique_users: number;
}

export interface ColdUserRow {
  email: string;
  role: "admin" | "manager" | "am";
  am_name: string | null;
  last_active: string;
  days_inactive: number;
}

export interface RecentEventRow {
  email: string;
  role: string;
  event_name: string;
  surface: string | null;
  path: string | null;
  entity_id: string | null;
  ts: string;
}

// ---------------------------------------------------------------------------

export async function getUsageSummary(): Promise<UsageSummary> {
  const sql = getSql();
  if (!sql) return { dau: 0, wau: 0, mau: 0, total_events_7d: 0, total_sign_ins_7d: 0 };

  const rows = await sql`
    SELECT
      COUNT(DISTINCT CASE WHEN ts > NOW() - INTERVAL '1 day'   THEN email END)::int AS dau,
      COUNT(DISTINCT CASE WHEN ts > NOW() - INTERVAL '7 days'  THEN email END)::int AS wau,
      COUNT(DISTINCT CASE WHEN ts > NOW() - INTERVAL '30 days' THEN email END)::int AS mau,
      COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '7 days')::int                    AS total_events_7d,
      COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '7 days' AND event_name = 'sign_in')::int AS total_sign_ins_7d
    FROM am_activity_log
  `;
  const r = rows[0] || {};
  return {
    dau: r.dau ?? 0,
    wau: r.wau ?? 0,
    mau: r.mau ?? 0,
    total_events_7d: r.total_events_7d ?? 0,
    total_sign_ins_7d: r.total_sign_ins_7d ?? 0,
  };
}

export async function getDailyActivity(days: number = 30): Promise<DailyActivityRow[]> {
  const sql = getSql();
  if (!sql) return [];

  const rows = await sql`
    SELECT
      TO_CHAR(DATE_TRUNC('day', ts), 'YYYY-MM-DD') AS date,
      COUNT(*)::int                                AS events,
      COUNT(DISTINCT email)::int                   AS unique_users
    FROM am_activity_log
    WHERE ts > NOW() - (${days}::int || ' days')::interval
    GROUP BY DATE_TRUNC('day', ts)
    ORDER BY DATE_TRUNC('day', ts) ASC
  `;
  return rows.map((r: any) => ({
    date: r.date,
    events: r.events,
    unique_users: r.unique_users,
  }));
}

export async function getPerUserStats(): Promise<PerUserRow[]> {
  const sql = getSql();
  if (!sql) return [];

  const rows = await sql`
    SELECT
      email,
      (ARRAY_AGG(role ORDER BY ts DESC))[1] AS role,
      (ARRAY_AGG(am_name ORDER BY ts DESC))[1] AS am_name,
      MAX(ts) AS last_active,
      COUNT(*) FILTER (WHERE event_name = 'sign_in')::int          AS sign_ins,
      COUNT(*)::int                                                AS total_events,
      COUNT(*) FILTER (WHERE event_name = 'customer_opened')::int  AS customer_opens,
      COUNT(*) FILTER (WHERE event_name = 'page_view')::int        AS pages_viewed,
      COUNT(*) FILTER (WHERE event_name IN ('mark_contacted', 'note_saved', 'snooze_set', 'coaching_acted'))::int AS actions_taken,
      COUNT(*) FILTER (WHERE event_name = 'filter_changed')::int   AS filter_changes
    FROM am_activity_log
    WHERE ts > NOW() - INTERVAL '30 days'
    GROUP BY email
    ORDER BY MAX(ts) DESC
  `;
  return rows.map((r: any) => ({
    email: r.email,
    role: r.role,
    am_name: r.am_name,
    last_active: typeof r.last_active === "string" ? r.last_active : new Date(r.last_active).toISOString(),
    sign_ins: r.sign_ins,
    total_events: r.total_events,
    customer_opens: r.customer_opens,
    pages_viewed: r.pages_viewed,
    actions_taken: r.actions_taken ?? 0,
    filter_changes: r.filter_changes ?? 0,
  }));
}

export async function getTopPaths(limit: number = 15): Promise<TopPathRow[]> {
  const sql = getSql();
  if (!sql) return [];

  const rows = await sql`
    SELECT
      metadata->>'path' AS path,
      COUNT(*)::int                AS hits,
      COUNT(DISTINCT email)::int   AS unique_users
    FROM am_activity_log
    WHERE event_name = 'api_call'
      AND ts > NOW() - INTERVAL '7 days'
      AND metadata->>'path' IS NOT NULL
    GROUP BY metadata->>'path'
    ORDER BY hits DESC
    LIMIT ${limit}
  `;
  return rows.map((r: any) => ({
    path: r.path,
    hits: r.hits,
    unique_users: r.unique_users,
  }));
}

export async function getColdUsers(daysInactive: number = 7): Promise<ColdUserRow[]> {
  const sql = getSql();
  if (!sql) return [];

  const rows = await sql`
    SELECT
      email,
      (ARRAY_AGG(role ORDER BY ts DESC))[1] AS role,
      (ARRAY_AGG(am_name ORDER BY ts DESC))[1] AS am_name,
      MAX(ts) AS last_active,
      FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(ts))) / 86400)::int AS days_inactive
    FROM am_activity_log
    GROUP BY email
    HAVING MAX(ts) < NOW() - (${daysInactive}::int || ' days')::interval
    ORDER BY MAX(ts) ASC
  `;
  return rows.map((r: any) => ({
    email: r.email,
    role: r.role,
    am_name: r.am_name,
    last_active: typeof r.last_active === "string" ? r.last_active : new Date(r.last_active).toISOString(),
    days_inactive: r.days_inactive,
  }));
}

export async function getRecentEvents(limit: number = 50): Promise<RecentEventRow[]> {
  const sql = getSql();
  if (!sql) return [];

  const rows = await sql`
    SELECT
      email,
      role,
      event_name,
      surface,
      metadata->>'path' AS path,
      entity_id,
      ts
    FROM am_activity_log
    ORDER BY ts DESC
    LIMIT ${limit}
  `;
  return rows.map((r: any) => ({
    email: r.email,
    role: r.role,
    event_name: r.event_name,
    surface: r.surface,
    path: r.path,
    entity_id: r.entity_id,
    ts: typeof r.ts === "string" ? r.ts : new Date(r.ts).toISOString(),
  }));
}
