import { neon, NeonQueryFunction } from "@neondatabase/serverless";
import { pgConfigured, SNAPSHOT_RETENTION_DAYS } from "./config";
import type {
  DashboardSnapshotRow,
  AmActionRow,
  SignalFeedbackRow,
  SnapshotV2,
} from "./types";
import type { Stoplight } from "./config";

/**
 * Thin Neon Postgres client wrapper. Returns null when POSTGRES_URL is unset
 * so local development without Neon still works (falls back to in-memory).
 */
let _sql: NeonQueryFunction<false, false> | null = null;
export function getSql(): NeonQueryFunction<false, false> | null {
  if (!pgConfigured()) return null;
  if (!_sql) _sql = neon(process.env.POSTGRES_URL!);
  return _sql;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** Write today's snapshot. Overwrites if same snapshot_date already exists. */
export async function writeSnapshotV2(snap: SnapshotV2): Promise<void> {
  const sql = getSql();
  if (!sql) {
    console.warn("[postgres] POSTGRES_URL not set — skipping snapshot write");
    return;
  }
  const date = snap.generatedAt.slice(0, 10);  // YYYY-MM-DD
  const sources: Record<string, string> = {};
  if (snap.errors) for (const e of snap.errors) sources[e.split(":")[0]] = "error";

  await sql`
    INSERT INTO dashboard_snapshots (
      snapshot_date, generated_at, total_customers,
      total_high_risk, total_watch, total_medium, total_low, total_healthy,
      customer_data, data_sources_status, refresh_duration_ms
    ) VALUES (
      ${date}, ${snap.generatedAt}, ${snap.totalActive},
      ${snap.tierCounts.HIGH || 0},
      ${snap.stoplightCounts?.YELLOW || 0},
      ${snap.tierCounts.MEDIUM || 0},
      ${snap.tierCounts.LOW || 0},
      ${snap.tierCounts.HEALTHY || 0},
      ${JSON.stringify(snap)}::jsonb,
      ${JSON.stringify(sources)}::jsonb,
      ${snap.health.refreshDurationMs}
    )
    ON CONFLICT (snapshot_date) DO UPDATE SET
      generated_at = EXCLUDED.generated_at,
      total_customers = EXCLUDED.total_customers,
      total_high_risk = EXCLUDED.total_high_risk,
      total_watch = EXCLUDED.total_watch,
      total_medium = EXCLUDED.total_medium,
      total_low = EXCLUDED.total_low,
      total_healthy = EXCLUDED.total_healthy,
      customer_data = EXCLUDED.customer_data,
      data_sources_status = EXCLUDED.data_sources_status,
      refresh_duration_ms = EXCLUDED.refresh_duration_ms
  `;
  console.log("[postgres] snapshot written for", date);
}

/** Read latest snapshot (today's, or most recent). */
export async function readLatestSnapshotV2(): Promise<SnapshotV2 | null> {
  const sql = getSql();
  if (!sql) return null;
  const rows = await sql`
    SELECT customer_data FROM dashboard_snapshots
    ORDER BY snapshot_date DESC LIMIT 1
  `;
  if (!rows.length) return null;
  return rows[0].customer_data as SnapshotV2;
}

/** Read snapshot for a specific date (YYYY-MM-DD), null if none. */
export async function readSnapshotByDate(date: string): Promise<SnapshotV2 | null> {
  const sql = getSql();
  if (!sql) return null;
  const rows = await sql`
    SELECT customer_data FROM dashboard_snapshots
    WHERE snapshot_date = ${date}
  `;
  if (!rows.length) return null;
  return rows[0].customer_data as SnapshotV2;
}

/** List snapshot dates available (most recent first), useful for trend views. */
export async function listSnapshotDates(limit: number = 90): Promise<string[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    SELECT snapshot_date FROM dashboard_snapshots
    ORDER BY snapshot_date DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => (r as { snapshot_date: string }).snapshot_date);
}

/** Prune snapshots older than retention window. Returns number of rows deleted. */
export async function pruneOldSnapshots(): Promise<number> {
  const sql = getSql();
  if (!sql) return 0;
  const rows = await sql`
    DELETE FROM dashboard_snapshots
    WHERE snapshot_date < (CURRENT_DATE - (${SNAPSHOT_RETENTION_DAYS}::int * INTERVAL '1 day'))
    RETURNING snapshot_date
  `;
  console.log("[postgres] pruned snapshots:", rows.length);
  return rows.length;
}

/** Tier-trend over the last N days for the Leadership view. */
export type TierTrendRow = {
  snapshot_date: string;
  total_customers: number;
  total_high_risk: number;
  total_watch: number;
  total_medium: number;
  total_low: number;
  total_healthy: number;
};
export async function readTierTrend(days: number = 30): Promise<TierTrendRow[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    SELECT snapshot_date, total_customers,
           total_high_risk, total_watch, total_medium, total_low, total_healthy
    FROM dashboard_snapshots
    WHERE snapshot_date >= (CURRENT_DATE - (${days}::int * INTERVAL '1 day'))
    ORDER BY snapshot_date ASC
  `;
  return rows as TierTrendRow[];
}

// ---------------------------------------------------------------------------
// AM actions
// ---------------------------------------------------------------------------

export async function writeAmAction(row: AmActionRow): Promise<number | null> {
  const sql = getSql();
  if (!sql) return null;
  // Best-effort idempotent ALTER — runs cheap and once.
  try {
    await sql`ALTER TABLE am_actions ADD COLUMN IF NOT EXISTS reason_code TEXT`;
    await sql`ALTER TABLE am_actions ADD COLUMN IF NOT EXISTS follow_up_date DATE`;
    await sql`ALTER TABLE am_actions ADD COLUMN IF NOT EXISTS escalated_to TEXT`;
  } catch { /* ignore */ }
  const result = await sql`
    INSERT INTO am_actions (
      am_name, entity_id, action_type, note, composite_at_action,
      reason_code, follow_up_date, escalated_to
    )
    VALUES (
      ${row.am_name},
      ${row.entity_id},
      ${row.action_type},
      ${row.note || null},
      ${row.composite_at_action ?? null},
      ${row.reason_code || null},
      ${row.follow_up_date || null},
      ${row.escalated_to || null}
    )
    RETURNING id
  `;
  return result[0]?.id as number;
}

// ---------------------------------------------------------------------------
// Outcome tracking (Phase 9.5): given a Mark Contacted event, evaluate
// whether the customer recovered N days later. Run from a daily cron.
// ---------------------------------------------------------------------------

let _outcomeTrackingReady = false;
async function ensureOutcomeTrackingTable(): Promise<void> {
  if (_outcomeTrackingReady) return;
  const sql = getSql();
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS outcome_tracking (
      action_id INT NOT NULL,
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      days_after INT NOT NULL,
      tier_at_action TEXT NOT NULL DEFAULT '',
      tier_now TEXT NOT NULL DEFAULT '',
      composite_at_action INT,
      composite_now INT,
      recovered BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (action_id, days_after)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_outcome_tracking_evaluated ON outcome_tracking (evaluated_at DESC)`;
  _outcomeTrackingReady = true;
}

export async function writeOutcomeRow(row: {
  action_id: number;
  days_after: number;
  tier_at_action: string;
  tier_now: string;
  composite_at_action: number | null;
  composite_now: number | null;
  recovered: boolean;
}): Promise<void> {
  const sql = getSql();
  if (!sql) return;
  await ensureOutcomeTrackingTable();
  await sql`
    INSERT INTO outcome_tracking (
      action_id, days_after, tier_at_action, tier_now,
      composite_at_action, composite_now, recovered
    )
    VALUES (
      ${row.action_id}, ${row.days_after}, ${row.tier_at_action}, ${row.tier_now},
      ${row.composite_at_action}, ${row.composite_now}, ${row.recovered}
    )
    ON CONFLICT (action_id, days_after) DO UPDATE SET
      evaluated_at = NOW(),
      tier_now = EXCLUDED.tier_now,
      composite_now = EXCLUDED.composite_now,
      recovered = EXCLUDED.recovered
  `;
}

/** Find action rows from N days ago that need outcome evaluation. */
export async function readActionsNeedingOutcomeEval(daysAfter: number): Promise<AmActionRow[]> {
  const sql = getSql();
  if (!sql) return [];
  await ensureOutcomeTrackingTable();
  // Actions created exactly N days ago that don't yet have an outcome row for this window
  const rows = await sql`
    SELECT a.id, a.am_name, a.entity_id, a.action_type, a.composite_at_action, a.created_at
    FROM am_actions a
    LEFT JOIN outcome_tracking o ON o.action_id = a.id AND o.days_after = ${daysAfter}
    WHERE a.created_at::date = (CURRENT_DATE - (${daysAfter}::int * INTERVAL '1 day'))::date
      AND a.action_type LIKE 'contacted_%'
      AND o.action_id IS NULL
  `;
  return rows as AmActionRow[];
}

/** Aggregate recovery stats — per-AM recovery rate within window. */
export async function readRecoveryStatsByAm(
  daysAfter: number = 14,
  windowDays: number = 90,
): Promise<Array<{ am_name: string; total: number; recovered: number; rate: number }>> {
  const sql = getSql();
  if (!sql) return [];
  await ensureOutcomeTrackingTable();
  const rows = await sql`
    SELECT
      a.am_name,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE o.recovered)::int AS recovered
    FROM outcome_tracking o
    JOIN am_actions a ON a.id = o.action_id
    WHERE o.days_after = ${daysAfter}
      AND o.evaluated_at >= (NOW() - (${windowDays}::int * INTERVAL '1 day'))
    GROUP BY a.am_name
    ORDER BY a.am_name ASC
  `;
  return rows.map((r) => {
    const row = r as { am_name: string; total: number; recovered: number };
    return {
      am_name: row.am_name,
      total: row.total,
      recovered: row.recovered,
      rate: row.total ? (row.recovered / row.total) * 100 : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Health check log (Phase 9.8): persist probe results + drive alerting
// ---------------------------------------------------------------------------

let _healthLogReady = false;
async function ensureHealthLogTable(): Promise<void> {
  if (_healthLogReady) return;
  const sql = getSql();
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS health_check_log (
      id SERIAL PRIMARY KEY,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ok BOOLEAN NOT NULL,
      probes JSONB NOT NULL DEFAULT '{}'::jsonb,
      error_count INT NOT NULL DEFAULT 0,
      alerted BOOLEAN NOT NULL DEFAULT FALSE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_health_check_log_checked_at ON health_check_log (checked_at DESC)`;
  _healthLogReady = true;
}

export async function writeHealthCheck(row: {
  ok: boolean;
  probes: Record<string, unknown>;
  error_count: number;
  alerted: boolean;
}): Promise<void> {
  const sql = getSql();
  if (!sql) return;
  await ensureHealthLogTable();
  await sql`
    INSERT INTO health_check_log (ok, probes, error_count, alerted)
    VALUES (${row.ok}, ${JSON.stringify(row.probes)}::jsonb, ${row.error_count}, ${row.alerted})
  `;
}

// ---------------------------------------------------------------------------
// Follow-ups + escalation queries (Phase 9 workflow)
// ---------------------------------------------------------------------------

/** Pending follow-ups for an AM in the next N days. */
export async function readPendingFollowUps(amName: string, daysAhead: number = 14): Promise<AmActionRow[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    SELECT id, am_name, entity_id, action_type, note, reason_code, follow_up_date, composite_at_action, created_at
    FROM am_actions
    WHERE am_name = ${amName}
      AND follow_up_date IS NOT NULL
      AND follow_up_date >= CURRENT_DATE
      AND follow_up_date <= (CURRENT_DATE + (${daysAhead}::int * INTERVAL '1 day'))::date
    ORDER BY follow_up_date ASC, created_at DESC
  `;
  return rows as AmActionRow[];
}



/** Recent actions across the book (for Pod Rollup "movers" + Wins panel). */
export async function readRecentActions(daysBack: number = 7): Promise<AmActionRow[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    SELECT id, am_name, entity_id, action_type, note, composite_at_action, created_at
    FROM am_actions
    WHERE created_at >= (NOW() - (${daysBack}::int * INTERVAL '1 day'))
    ORDER BY created_at DESC
  `;
  return rows as AmActionRow[];
}

/** Actions for a specific customer (for drill-down modal notes tab). */
export async function readCustomerActions(entityId: string, limit: number = 20): Promise<AmActionRow[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    SELECT id, am_name, entity_id, action_type, note, composite_at_action, created_at
    FROM am_actions
    WHERE entity_id = ${entityId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows as AmActionRow[];
}

/** "Has this customer been contacted in last N days?" — drives Act-today quieting. */
export async function entitiesContactedRecently(amName: string, daysBack: number = 7): Promise<Set<string>> {
  const sql = getSql();
  if (!sql) return new Set();
  const rows = await sql`
    SELECT DISTINCT entity_id FROM am_actions
    WHERE am_name = ${amName}
      AND created_at >= (NOW() - (${daysBack}::int * INTERVAL '1 day'))
  `;
  return new Set(rows.map((r) => (r as { entity_id: string }).entity_id));
}

// ---------------------------------------------------------------------------
// AM activity rollup (Phase 15.2): per-AM action counts + outcome breakdown
// over the last N days. Used by the manager dashboard "AM ACTIVITY" section.
// ---------------------------------------------------------------------------

export type AmOutcomeStats = {
  am_name: string;
  actions_total: number;
  connected: number;
  voicemail: number;
  no_reach: number;
  escalated: number;
  re_engaged: number;
};

export async function getAmOutcomeStats(daysBack: number = 7): Promise<AmOutcomeStats[]> {
  const sql = getSql();
  if (!sql) return [];
  // Guard against the table not existing yet (fresh install / migration not run).
  await ensureOutcomeTrackingTable();
  try {
    const rows = await sql`
      SELECT
        a.am_name,
        COUNT(DISTINCT a.id)::int AS actions_total,
        COUNT(DISTINCT CASE WHEN a.action_type = 'contacted_connected' THEN a.id END)::int AS connected,
        COUNT(DISTINCT CASE WHEN a.action_type = 'contacted_vm'        THEN a.id END)::int AS voicemail,
        COUNT(DISTINCT CASE WHEN a.action_type = 'contacted_noreach'   THEN a.id END)::int AS no_reach,
        COUNT(DISTINCT CASE WHEN a.action_type = 'escalated'           THEN a.id END)::int AS escalated,
        COUNT(DISTINCT CASE WHEN o.recovered = TRUE                    THEN o.action_id END)::int AS re_engaged
      FROM am_actions a
      LEFT JOIN outcome_tracking o ON o.action_id = a.id
      WHERE a.created_at >= (NOW() - (${daysBack}::int * INTERVAL '1 day'))
      GROUP BY a.am_name
      ORDER BY actions_total DESC, a.am_name ASC
    `;
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        am_name: String(row.am_name ?? ""),
        actions_total: Number(row.actions_total ?? 0),
        connected: Number(row.connected ?? 0),
        voicemail: Number(row.voicemail ?? 0),
        no_reach: Number(row.no_reach ?? 0),
        escalated: Number(row.escalated ?? 0),
        re_engaged: Number(row.re_engaged ?? 0),
      };
    });
  } catch (e) {
    console.warn("[postgres] getAmOutcomeStats failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Signal feedback
// ---------------------------------------------------------------------------

export async function writeSignalFeedback(row: SignalFeedbackRow): Promise<number | null> {
  const sql = getSql();
  if (!sql) return null;
  const result = await sql`
    INSERT INTO signal_feedback (entity_id, signal_name, am_name, comment)
    VALUES (${row.entity_id}, ${row.signal_name}, ${row.am_name}, ${row.comment || null})
    RETURNING id
  `;
  return result[0]?.id as number;
}

export async function readFeedbackForEntity(entityId: string): Promise<SignalFeedbackRow[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    SELECT id, entity_id, signal_name, am_name, comment, created_at
    FROM signal_feedback
    WHERE entity_id = ${entityId}
    ORDER BY created_at DESC
  `;
  return rows as SignalFeedbackRow[];
}

// ---------------------------------------------------------------------------
// Phase 3 — trend & movement queries
// Add these to lib/postgres.ts just before "Connection health check".
// ---------------------------------------------------------------------------


export type CustomerTrendPoint = {
  date: string;          // YYYY-MM-DD
  composite: number;
  stoplight: Stoplight;
  am_name: string;
  bizname: string;
};

/**
 * Per-customer composite-score trend over the last `days` days.
 * Uses LATERAL jsonb_array_elements on customer_data.customers so we don't
 * have to load the entire snapshot per day.
 */
export async function readCustomerTrend(
  entityId: string,
  days: number = 84,
): Promise<CustomerTrendPoint[]> {
  // Delegated to flat customer_trends table — Phase 7.C.
  return readCustomerTrendFlat(entityId, days);
}

export type AmBookTrendPoint = {
  date: string;
  total: number;
  red: number;
  yellow: number;
  green: number;
  mrr: number;
  mrr_at_risk: number;
};

/**
 * Per-AM book trend over the last `days` days. Aggregates customer
 * stoplights per snapshot day for one AM's book.
 */
export async function readAmBookTrend(
  amName: string,
  days: number = 84,
): Promise<AmBookTrendPoint[]> {
  // Delegated to flat customer_trends table — Phase 7.C.
  return readAmBookTrendFlat(amName, days);
}

export type StoplightMovementRow = {
  entity_id: string;
  bizname: string;
  am_name: string;
  pod?: string;
  from: Stoplight;
  to: Stoplight;
  composite_from: number;
  composite_to: number;
  plan_amount: number;
};

export type StoplightMovementResult = {
  days: number;
  comparedAt: string;
  currentAt: string;
  flippedToRed: StoplightMovementRow[];
  recoveries: StoplightMovementRow[];     // anything → GREEN
  degraded: StoplightMovementRow[];        // GREEN → YELLOW
};

/**
 * Compute stoplight movement between latest snapshot and N days ago.
 * Three buckets: flippedToRed, recoveries (→GREEN), degraded (GREEN→YELLOW).
 */
export async function readStoplightMovement(days: number = 7): Promise<StoplightMovementResult | null> {
  const sql = getSql();
  if (!sql) return null;
  // Fetch latest + N-days-ago in one round-trip via two queries:
  const latestRows = await sql`
    SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS date,
           customer_data
    FROM dashboard_snapshots
    ORDER BY snapshot_date DESC
    LIMIT 1
  `;
  if (!latestRows.length) return null;
  const latest = latestRows[0] as { date: string; customer_data: any };
  const currentAt = latest.date;

  const compareRows = await sql`
    SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS date,
           customer_data
    FROM dashboard_snapshots
    WHERE snapshot_date <= ((${currentAt})::date - (${days}::int * INTERVAL '1 day'))
    ORDER BY snapshot_date DESC
    LIMIT 1
  `;
  if (!compareRows.length) return null;
  const compare = compareRows[0] as { date: string; customer_data: any };

  const prevByEntity = new Map<string, any>();
  for (const c of compare.customer_data?.customers || []) {
    if (c?.entity_id) prevByEntity.set(c.entity_id, c);
  }

  const flippedToRed: StoplightMovementRow[] = [];
  const recoveries: StoplightMovementRow[] = [];
  const degraded: StoplightMovementRow[] = [];

  for (const c of latest.customer_data?.customers || []) {
    if (!c?.entity_id) continue;
    const prev = prevByEntity.get(c.entity_id);
    if (!prev) continue;
    const prevSl = prev.signals_v2?.stoplight as Stoplight;
    const curSl = c.signals_v2?.stoplight as Stoplight;
    if (!prevSl || !curSl || prevSl === curSl) continue;
    const row: StoplightMovementRow = {
      entity_id: c.entity_id,
      bizname: (c.bizname || c.company || "") as string,
      am_name: c.am_name || "",
      pod: c.pod || undefined,
      from: prevSl,
      to: curSl,
      composite_from: Number(prev.signals_v2?.composite || 0),
      composite_to: Number(c.signals_v2?.composite || 0),
      plan_amount: Number(c.plan_amount || 0),
    };
    if (curSl === "RED" && prevSl !== "RED") flippedToRed.push(row);
    if (curSl === "GREEN" && prevSl !== "GREEN") recoveries.push(row);
    if (prevSl === "GREEN" && curSl === "YELLOW") degraded.push(row);
  }

  // Sort by impact: flippedToRed by plan_amount desc, recoveries by composite jump desc
  flippedToRed.sort((a, b) => b.plan_amount - a.plan_amount);
  recoveries.sort((a, b) => (b.composite_to - b.composite_from) - (a.composite_to - a.composite_from));
  degraded.sort((a, b) => b.plan_amount - a.plan_amount);

  return {
    days,
    comparedAt: compare.date,
    currentAt,
    flippedToRed,
    recoveries,
    degraded,
  };
}

// ---------------------------------------------------------------------------
// Phase 3 polish — bundled multi-AM trend
// ---------------------------------------------------------------------------

export type AmBookTrendBundle = {
  am_name: string;
  points: AmBookTrendPoint[];
};

/**
 * Fetch book trend for multiple AMs in a single SQL pass. Used for the
 * "Top Movers" panel where we want a sparkline next to each AM row.
 */
export async function readMultipleAmBookTrends(
  amNames: string[],
  days: number = 14,
): Promise<AmBookTrendBundle[]> {
  // Delegated to flat customer_trends table — Phase 7.C.
  return readMultipleAmBookTrendsFlat(amNames, days);
}

// ---------------------------------------------------------------------------
// Phase 3 deep polish — pod trend + batch customer trend
// Append to lib/postgres.ts just before the "Connection health check" section.
// Re-exports the AmBookTrendPoint type already defined above.
// ---------------------------------------------------------------------------

export type CustomerTrendPointLite = {
  date: string;
  composite: number;
  stoplight: Stoplight;
};

export type CustomerTrendBundle = {
  entity_id: string;
  points: CustomerTrendPointLite[];
};

/**
 * Batch per-customer composite-score trend in a single SQL pass.
 * Used by V2CustomerCard to show a tiny sparkline per visible card.
 */
export async function readMultipleCustomerTrends(
  entityIds: string[],
  days: number = 14,
): Promise<CustomerTrendBundle[]> {
  // Delegated to flat customer_trends table — Phase 7.C.
  return readMultipleCustomerTrendsFlat(entityIds, days);
}

export type PodTrendPoint = {
  date: string;
  red: number;
  yellow: number;
  green: number;
  total: number;
};

export type PodTrendBundle = {
  pod: string;
  points: PodTrendPoint[];
};

/**
 * Per-pod book trend. Groups by am_name in SQL then aggregates to pod in JS
 * (so we can use the canonical POD_MAP in code rather than re-encoding it
 * as a SQL CASE statement).
 */
export async function readPodTrend(
  amToPod: Record<string, string>,
  days: number = 14,
): Promise<PodTrendBundle[]> {
  // Delegated to flat customer_trends table — Phase 7.C.
  // amToPod argument is kept for backward compat but ignored — pod is denormalized.
  void amToPod;
  return readPodTrendFlat(days);
}

let _customerTrendsReady = false;

/** Idempotently ensure the customer_trends table + indexes exist. */
export async function ensureCustomerTrendsTable(): Promise<void> {
  if (_customerTrendsReady) return;
  const sql = getSql();
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS customer_trends (
      snapshot_date DATE NOT NULL,
      entity_id TEXT NOT NULL,
      am_name TEXT NOT NULL DEFAULT '',
      pod TEXT NOT NULL DEFAULT '',
      composite INT NOT NULL DEFAULT 0,
      stoplight TEXT NOT NULL DEFAULT 'GREEN',
      plan_amount NUMERIC NOT NULL DEFAULT 0,
      perf_flagged BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (entity_id, snapshot_date)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_customer_trends_am_date ON customer_trends (am_name, snapshot_date DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_customer_trends_pod_date ON customer_trends (pod, snapshot_date DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_customer_trends_date ON customer_trends (snapshot_date DESC)`;
  _customerTrendsReady = true;
}

/** Bulk-write per-customer rows for a snapshot. One HTTP round-trip via unnest. */
export async function writeCustomerTrendRows(
  snapshotDate: string,
  rows: Array<{
    entity_id: string;
    am_name: string;
    pod: string;
    composite: number;
    stoplight: string;
    plan_amount: number;
    perf_flagged: boolean;
  }>,
): Promise<number> {
  const sql = getSql();
  if (!sql || !rows.length) return 0;
  await ensureCustomerTrendsTable();

  const entityIds = rows.map((r) => r.entity_id);
  const amNames = rows.map((r) => r.am_name || "");
  const pods = rows.map((r) => r.pod || "");
  const composites = rows.map((r) => Math.round(r.composite || 0));
  const stoplights = rows.map((r) => r.stoplight || "GREEN");
  const planAmounts = rows.map((r) => Number(r.plan_amount || 0));
  const flagged = rows.map((r) => !!r.perf_flagged);

  await sql`
    INSERT INTO customer_trends
      (snapshot_date, entity_id, am_name, pod, composite, stoplight, plan_amount, perf_flagged)
    SELECT
      ${snapshotDate}::date,
      e.entity_id,
      e.am_name,
      e.pod,
      e.composite,
      e.stoplight,
      e.plan_amount,
      e.perf_flagged
    FROM unnest(
      ${entityIds}::text[],
      ${amNames}::text[],
      ${pods}::text[],
      ${composites}::int[],
      ${stoplights}::text[],
      ${planAmounts}::numeric[],
      ${flagged}::boolean[]
    ) AS e(entity_id, am_name, pod, composite, stoplight, plan_amount, perf_flagged)
    ON CONFLICT (entity_id, snapshot_date) DO UPDATE SET
      am_name = EXCLUDED.am_name,
      pod = EXCLUDED.pod,
      composite = EXCLUDED.composite,
      stoplight = EXCLUDED.stoplight,
      plan_amount = EXCLUDED.plan_amount,
      perf_flagged = EXCLUDED.perf_flagged
  `;

  return rows.length;
}

// ---------------------------------------------------------------------------
// Replaces the LATERAL-based versions below: same signatures, flat-table SQL.
// ---------------------------------------------------------------------------

export async function readCustomerTrendFlat(
  entityId: string,
  days: number = 84,
): Promise<CustomerTrendPoint[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    SELECT
      to_char(snapshot_date, 'YYYY-MM-DD') AS date,
      composite,
      stoplight,
      am_name
    FROM customer_trends
    WHERE entity_id = ${entityId}
      AND snapshot_date >= (CURRENT_DATE - (${days}::int * INTERVAL '1 day'))
    ORDER BY snapshot_date ASC
  `;
  return rows.map((r) => {
    const row = r as { date: string; composite: number; stoplight: string; am_name: string };
    return {
      date: row.date,
      composite: row.composite,
      stoplight: (row.stoplight as Stoplight) || "GREEN",
      am_name: row.am_name || "",
      bizname: "",                          // not stored in the flat table
    };
  });
}

export async function readMultipleCustomerTrendsFlat(
  entityIds: string[],
  days: number = 14,
): Promise<CustomerTrendBundle[]> {
  const sql = getSql();
  if (!sql || !entityIds.length) return [];
  const rows = await sql`
    SELECT
      entity_id,
      to_char(snapshot_date, 'YYYY-MM-DD') AS date,
      composite,
      stoplight
    FROM customer_trends
    WHERE entity_id = ANY(${entityIds}::text[])
      AND snapshot_date >= (CURRENT_DATE - (${days}::int * INTERVAL '1 day'))
    ORDER BY entity_id ASC, snapshot_date ASC
  `;
  const byEntity = new Map<string, CustomerTrendPointLite[]>();
  for (const r of rows) {
    const row = r as {
      entity_id: string;
      date: string;
      composite: number;
      stoplight: string;
    };
    if (!byEntity.has(row.entity_id)) byEntity.set(row.entity_id, []);
    byEntity.get(row.entity_id)!.push({
      date: row.date,
      composite: row.composite,
      stoplight: (row.stoplight as Stoplight) || "GREEN",
    });
  }
  return entityIds.map((eid) => ({
    entity_id: eid,
    points: byEntity.get(eid) || [],
  }));
}

export async function readAmBookTrendFlat(
  amName: string,
  days: number = 84,
): Promise<AmBookTrendPoint[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    SELECT
      to_char(snapshot_date, 'YYYY-MM-DD') AS date,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE stoplight = 'RED')::int AS red,
      COUNT(*) FILTER (WHERE stoplight = 'YELLOW')::int AS yellow,
      COUNT(*) FILTER (WHERE stoplight = 'GREEN')::int AS green,
      COALESCE(SUM(plan_amount), 0)::numeric AS mrr,
      COALESCE(SUM(CASE WHEN stoplight = 'RED' THEN plan_amount ELSE 0 END), 0)::numeric AS mrr_at_risk
    FROM customer_trends
    WHERE am_name = ${amName}
      AND snapshot_date >= (CURRENT_DATE - (${days}::int * INTERVAL '1 day'))
    GROUP BY snapshot_date
    ORDER BY snapshot_date ASC
  `;
  return rows.map((r) => {
    const row = r as {
      date: string;
      total: number;
      red: number;
      yellow: number;
      green: number;
      mrr: string | number;
      mrr_at_risk: string | number;
    };
    return {
      date: row.date,
      total: row.total,
      red: row.red,
      yellow: row.yellow,
      green: row.green,
      mrr: Number(row.mrr),
      mrr_at_risk: Number(row.mrr_at_risk),
    };
  });
}

export async function readMultipleAmBookTrendsFlat(
  amNames: string[],
  days: number = 14,
): Promise<AmBookTrendBundle[]> {
  const sql = getSql();
  if (!sql || !amNames.length) return [];
  const rows = await sql`
    SELECT
      am_name,
      to_char(snapshot_date, 'YYYY-MM-DD') AS date,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE stoplight = 'RED')::int AS red,
      COUNT(*) FILTER (WHERE stoplight = 'YELLOW')::int AS yellow,
      COUNT(*) FILTER (WHERE stoplight = 'GREEN')::int AS green,
      COALESCE(SUM(plan_amount), 0)::numeric AS mrr,
      COALESCE(SUM(CASE WHEN stoplight = 'RED' THEN plan_amount ELSE 0 END), 0)::numeric AS mrr_at_risk
    FROM customer_trends
    WHERE am_name = ANY(${amNames}::text[])
      AND snapshot_date >= (CURRENT_DATE - (${days}::int * INTERVAL '1 day'))
    GROUP BY am_name, snapshot_date
    ORDER BY am_name ASC, snapshot_date ASC
  `;
  const byAm = new Map<string, AmBookTrendPoint[]>();
  for (const r of rows) {
    const row = r as {
      am_name: string;
      date: string;
      total: number;
      red: number;
      yellow: number;
      green: number;
      mrr: string | number;
      mrr_at_risk: string | number;
    };
    if (!byAm.has(row.am_name)) byAm.set(row.am_name, []);
    byAm.get(row.am_name)!.push({
      date: row.date,
      total: row.total,
      red: row.red,
      yellow: row.yellow,
      green: row.green,
      mrr: Number(row.mrr),
      mrr_at_risk: Number(row.mrr_at_risk),
    });
  }
  return amNames.map((am) => ({
    am_name: am,
    points: byAm.get(am) || [],
  }));
}

export async function readPodTrendFlat(days: number = 14): Promise<PodTrendBundle[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    SELECT
      pod,
      to_char(snapshot_date, 'YYYY-MM-DD') AS date,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE stoplight = 'RED')::int AS red,
      COUNT(*) FILTER (WHERE stoplight = 'YELLOW')::int AS yellow,
      COUNT(*) FILTER (WHERE stoplight = 'GREEN')::int AS green
    FROM customer_trends
    WHERE snapshot_date >= (CURRENT_DATE - (${days}::int * INTERVAL '1 day'))
    GROUP BY pod, snapshot_date
    ORDER BY pod ASC, snapshot_date ASC
  `;
  const byPod = new Map<string, PodTrendPoint[]>();
  for (const r of rows) {
    const row = r as {
      pod: string;
      date: string;
      total: number;
      red: number;
      yellow: number;
      green: number;
    };
    const pod = row.pod || "Floating";
    if (!byPod.has(pod)) byPod.set(pod, []);
    byPod.get(pod)!.push({
      date: row.date,
      total: row.total,
      red: row.red,
      yellow: row.yellow,
      green: row.green,
    });
  }
  return Array.from(byPod.entries())
    .map(([pod, points]) => ({ pod, points }))
    .sort((a, b) => a.pod.localeCompare(b.pod));
}



// ---------------------------------------------------------------------------
// HubSpot note enrichment cache (Phase 13.4)
// One row per note_id; lets us skip re-Haiku when the note content is stable.
// ---------------------------------------------------------------------------

let _noteEnrichReady = false;
async function ensureNoteEnrichmentTable(): Promise<void> {
  if (_noteEnrichReady) return;
  const sql = getSql();
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS hubspot_note_enrichment (
      note_id TEXT PRIMARY KEY,
      enriched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sentiment TEXT NOT NULL DEFAULT 'neutral',
      topics JSONB NOT NULL DEFAULT '[]'::jsonb,
      action_items JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `;
  _noteEnrichReady = true;
}

export type CachedNoteEnrichment = {
  sentiment: "warm" | "neutral" | "frustrated";
  topics: string[];
  action_items: string[];
};

/** Read cached enrichments for a list of note_ids. */
export async function readNoteEnrichments(noteIds: string[]): Promise<Map<string, CachedNoteEnrichment>> {
  const map = new Map<string, CachedNoteEnrichment>();
  const sql = getSql();
  if (!sql || !noteIds.length) return map;
  await ensureNoteEnrichmentTable();
  const rows = await sql`
    SELECT note_id, sentiment, topics, action_items
    FROM hubspot_note_enrichment
    WHERE note_id = ANY(${noteIds}::text[])
  `;
  for (const r of rows) {
    const row = r as {
      note_id: string;
      sentiment: string;
      topics: string[];
      action_items: string[];
    };
    map.set(row.note_id, {
      sentiment: (["warm", "neutral", "frustrated"].includes(row.sentiment)
        ? row.sentiment
        : "neutral") as CachedNoteEnrichment["sentiment"],
      topics: Array.isArray(row.topics) ? row.topics : [],
      action_items: Array.isArray(row.action_items) ? row.action_items : [],
    });
  }
  return map;
}

/** Persist new enrichments to the cache. */
export async function writeNoteEnrichments(items: Map<string, CachedNoteEnrichment>): Promise<void> {
  const sql = getSql();
  if (!sql || items.size === 0) return;
  await ensureNoteEnrichmentTable();
  // Bulk insert via unnest
  const ids: string[] = [];
  const sentiments: string[] = [];
  const topics: string[] = [];
  const actions: string[] = [];
  for (const [noteId, e] of items) {
    ids.push(noteId);
    sentiments.push(e.sentiment);
    topics.push(JSON.stringify(e.topics));
    actions.push(JSON.stringify(e.action_items));
  }
  await sql`
    INSERT INTO hubspot_note_enrichment (note_id, sentiment, topics, action_items)
    SELECT * FROM unnest(
      ${ids}::text[],
      ${sentiments}::text[],
      ${topics}::jsonb[],
      ${actions}::jsonb[]
    )
    ON CONFLICT (note_id) DO UPDATE SET
      enriched_at = NOW(),
      sentiment = EXCLUDED.sentiment,
      topics = EXCLUDED.topics,
      action_items = EXCLUDED.action_items
  `;
}

// ---------------------------------------------------------------------------
// Connection health check
// ---------------------------------------------------------------------------

export async function pingPostgres(): Promise<{ ok: boolean; error?: string }> {
  const sql = getSql();
  if (!sql) return { ok: false, error: "POSTGRES_URL not set" };
  try {
    await sql`SELECT 1`;
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
