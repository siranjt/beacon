import { getSql } from "./postgres";
import { ACTIVE_AMS } from "./config";
import type { SnapshotV2, ScoredCustomerV2 } from "./types";

import { normalizeHealthTier } from "@/lib/customer/config";
import { getHealthCardMap } from "@/lib/customer/health-card";
/**
 * Phase 27 — Coaching loops.
 *
 * Four per-AM behavioral signals derived from the current snapshot + the
 * am_actions / snooze_tracking write history. These surface as a manager-view
 * section (one row per AM) and as a per-AM "Heads up" pill bar in the AM's
 * own triage view.
 *
 *  - red_untouched_7d   — RED customers where the AM has not logged an
 *                         am_action in the last 7 days AND last_any_iso is
 *                         either null or older than 7 days.
 *  - stale_red_14d      — RED customers whose last_any_iso is null or older
 *                         than 14 days (v1 proxy for "RED 14+ days running";
 *                         Phase 30 will switch to snapshot-history derivation).
 *  - noreach_streak_3plus — RED customers whose last three am_actions for this
 *                         (am, entity) are all `contacted_noreach`.
 *  - snooze_ignored     — Customers whose most-recent snooze elapsed but the
 *                         AM has not logged a follow-up am_action after the
 *                         snooze ended.
 *
 * Everything runs as 3 aggregate SQL queries — no per-customer N+1 loop —
 * and is combined against the snapshot's RED-customer list in JS. Returns
 * empty array (graceful) when POSTGRES_URL isn't set OR if the underlying
 * SQL errors. Never throws to the caller.
 */

export type CoachingRow = {
  am_name: string;
  red_untouched_7d: { count: number; mrr_at_risk_cents: number; entity_ids: string[] };
  stale_red_14d: { count: number; entity_ids: string[] };
  noreach_streak_3plus: { count: number; entity_ids: string[] };
  snooze_ignored: { count: number; entity_ids: string[] };
  total_red: number;
  total_mrr_at_risk_cents: number;
};

export type CoachingMetric =
  | "untouched_7d"
  | "stale_14d"
  | "noreach_streak"
  | "snooze_ignored";

const DAY_MS = 86_400_000;
// Pipe separator for compound keys — AM names contain spaces ("Kanak sharma")
// so a space-delimited key would split incorrectly downstream. Pipe is safe
// because entity_ids are UUIDs (hex + dashes) and AM names are alphanumeric+space.
const KEY_SEP = "|";

function compoundKey(am: string, eid: string): string {
  return `${am}${KEY_SEP}${eid}`;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(KEY_SEP);
  if (i < 0) return [key, ""];
  return [key.slice(0, i), key.slice(i + 1)];
}

function daysSinceIso(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (now - t) / DAY_MS;
}

function emptyRow(amName: string): CoachingRow {
  return {
    am_name: amName,
    red_untouched_7d: { count: 0, mrr_at_risk_cents: 0, entity_ids: [] },
    stale_red_14d: { count: 0, entity_ids: [] },
    noreach_streak_3plus: { count: 0, entity_ids: [] },
    snooze_ignored: { count: 0, entity_ids: [] },
    total_red: 0,
    total_mrr_at_risk_cents: 0,
  };
}

export async function getCoachingPerAm(
  snapshot: SnapshotV2,
): Promise<CoachingRow[]> {
  try {
    const sql = getSql();

    // Bucket all RED customers in the snapshot by AM. Always seed the result
    // map with every active AM so AMs with zero RED still render.
    const byAm = new Map<string, CoachingRow>();
    for (const am of ACTIVE_AMS) byAm.set(am, emptyRow(am));

    // Phase 33.E.6.2 — pull the health-card map directly. Snapshot.customers
    // don't carry metabase_health when read via readLatestSnapshotV2() (the
    // enrichment lives in /api/v2/snapshot/route.ts only).
    const _healthMap = await getHealthCardMap().catch(() => new Map());

    const redByAm = new Map<string, ScoredCustomerV2[]>();
    for (const c of snapshot.customers || []) {
      if (!c?.am_name) continue;
      // Phase 33.E.6 / 33.E.6.2 — needs-call-today filter.
      // Look up tier from the health-card map (keyed on lowercase entity_id).
      // Fall back to legacy stoplight === "RED" only when entity isn't in the
      // map (the ~13 orphans without health-card coverage).
      const _eid = (c.entity_id || "").toLowerCase();
      const _hcRow: any = _healthMap.get(_eid);
      const _ht = normalizeHealthTier(_hcRow?.health_tier);
      const _needsCall =
        _ht === "CRITICAL" || _ht === "AT-RISK" ||
        (_ht === null && c.signals_v2?.stoplight === "RED");
      if (!_needsCall) continue;
      // Skip pre-launch — those aren't real churn risk regardless of tier.
      if (c.signals_v2?.pre_launch) continue;
      if (!redByAm.has(c.am_name)) redByAm.set(c.am_name, []);
      redByAm.get(c.am_name)!.push(c);

      // Ensure the row exists even for AMs not in ACTIVE_AMS (defensive).
      if (!byAm.has(c.am_name)) byAm.set(c.am_name, emptyRow(c.am_name));
      const row = byAm.get(c.am_name)!;
      row.total_red += 1;
      row.total_mrr_at_risk_cents += Math.round((c.plan_amount || 0) * 100);
    }

    // No SQL configured — return the snapshot-only rows. Stale-14d still
    // works (snapshot-only); the other three buckets stay zero.
    if (!sql) {
      const now = Date.now();
      for (const [am, customers] of redByAm) {
        const row = byAm.get(am)!;
        for (const c of customers) {
          const days = daysSinceIso(c.metrics?.last_any_iso ?? null, now);
          const isStale14 = days === null || days > 14;
          if (isStale14) {
            row.stale_red_14d.count += 1;
            row.stale_red_14d.entity_ids.push(c.entity_id);
          }
          // Without SQL we can't dedupe against "touched recently in am_actions",
          // so use snapshot-only proxy for untouched_7d.
          const isUntouched7 = days === null || days > 7;
          if (isUntouched7) {
            row.red_untouched_7d.count += 1;
            row.red_untouched_7d.mrr_at_risk_cents += Math.round(
              (c.plan_amount || 0) * 100,
            );
            row.red_untouched_7d.entity_ids.push(c.entity_id);
          }
        }
      }
      return finalize(byAm);
    }

    // --- Query 1: distinct (am_name, entity_id) touched in last 7d ----------
    // Phase 31.v2.1: cast entity_id to text on the column side. The live
    // am_actions.entity_id is UUID (legacy schema), so the Set<string>
    // comparison against snapshot's text entity_id would never match without
    // this cast. SELECT-side cast keeps downstream code identical.
    const touched7Rows = (await sql`
      SELECT DISTINCT am_name, entity_id::text AS entity_id
      FROM am_actions
      WHERE created_at >= (NOW() - (7::int * INTERVAL '1 day'))
    `) as Array<{ am_name: string; entity_id: string }>;
    const touched7 = new Set<string>();
    for (const r of touched7Rows) touched7.add(compoundKey(r.am_name, r.entity_id));

    // --- Query 2: last-3 action types per (am, entity) ----------------------
    // We use array_agg over the latest 3 rows to test for an all-noreach streak.
    // Only consider entities the snapshot says are RED for these AMs — keeps
    // the result set bounded.
    const redEntityIds = Array.from(
      new Set(
        Array.from(redByAm.values()).flatMap((cs) => cs.map((c) => c.entity_id)),
      ),
    );
    const redAmNames = Array.from(redByAm.keys());

    let last3Rows: Array<{
      am_name: string;
      entity_id: string;
      last_types: string[];
    }> = [];
    if (redEntityIds.length > 0 && redAmNames.length > 0) {
      // Phase 31.v2.1: cast entity_id::text on both filter and select sides
      // because the column is UUID in the live DB.
      last3Rows = (await sql`
        SELECT am_name, entity_id, last_types
        FROM (
          SELECT
            am_name,
            entity_id::text AS entity_id,
            (ARRAY_AGG(action_type ORDER BY created_at DESC))[1:3] AS last_types,
            COUNT(*)::int AS n_total
          FROM am_actions
          WHERE am_name = ANY(${redAmNames}::text[])
            AND entity_id::text = ANY(${redEntityIds}::text[])
            AND action_type LIKE 'contacted_%'
          GROUP BY am_name, entity_id
        ) sub
        WHERE n_total >= 3
      `) as Array<{ am_name: string; entity_id: string; last_types: string[] }>;
    }
    const noreachStreakSet = new Set<string>();
    for (const r of last3Rows) {
      const arr = Array.isArray(r.last_types) ? r.last_types : [];
      if (arr.length >= 3 && arr.slice(0, 3).every((t) => t === "contacted_noreach")) {
        noreachStreakSet.add(compoundKey(r.am_name, r.entity_id));
      }
    }

    // --- Query 3: snooze-and-ignore ----------------------------------------
    // Most recent elapsed snooze per (am, entity), and whether ANY am_action
    // was logged after that snooze ended.
    // Phase 31.v2.1: snooze_tracking.entity_id is TEXT, am_actions.entity_id
    // is UUID. The JOIN compares them directly without casts, which is the
    // canonical "operator does not exist: uuid = text" trigger. Cast both
    // sides to text so the JOIN works regardless of either column's type.
    const ignoredRows = (await sql`
      WITH latest_elapsed AS (
        SELECT DISTINCT ON (am_name, entity_id)
          am_name,
          entity_id::text AS entity_id,
          snoozed_until
        FROM snooze_tracking
        WHERE snoozed_until < NOW()
        ORDER BY am_name, entity_id, snoozed_until DESC
      )
      SELECT le.am_name, le.entity_id
      FROM latest_elapsed le
      LEFT JOIN am_actions a
        ON a.am_name = le.am_name
       AND a.entity_id::text = le.entity_id
       AND a.created_at > le.snoozed_until
      WHERE a.id IS NULL
    `) as Array<{ am_name: string; entity_id: string }>;
    const ignoredSet = new Set<string>();
    for (const r of ignoredRows) ignoredSet.add(compoundKey(r.am_name, r.entity_id));

    // --- Combine in JS over the snapshot's RED set --------------------------
    const now = Date.now();
    for (const [am, customers] of redByAm) {
      const row = byAm.get(am)!;
      for (const c of customers) {
        const key = compoundKey(am, c.entity_id);
        const days = daysSinceIso(c.metrics?.last_any_iso ?? null, now);
        const planCents = Math.round((c.plan_amount || 0) * 100);

        // Untouched 7d: comms quiet >7d AND no am_action logged in last 7d.
        const recentlyTouched = touched7.has(key);
        const commsQuiet7 = days === null || days > 7;
        if (commsQuiet7 && !recentlyTouched) {
          row.red_untouched_7d.count += 1;
          row.red_untouched_7d.mrr_at_risk_cents += planCents;
          row.red_untouched_7d.entity_ids.push(c.entity_id);
        }

        // Stale 14d (v1 proxy)
        if (days === null || days > 14) {
          row.stale_red_14d.count += 1;
          row.stale_red_14d.entity_ids.push(c.entity_id);
        }

        // No-reach streak (last 3 actions are all contacted_noreach)
        if (noreachStreakSet.has(key)) {
          row.noreach_streak_3plus.count += 1;
          row.noreach_streak_3plus.entity_ids.push(c.entity_id);
        }
      }
    }

    // Snooze-ignored isn't scoped to RED — it can apply to any customer the AM
    // snoozed. Fold every (am, entity) ignored pair into its AM's bucket. We
    // still attribute to ACTIVE_AMS rows (seeded above) — unknown AMs get
    // a fresh row.
    for (const key of ignoredSet) {
      const [am, eid] = splitKey(key);
      if (!am) continue;
      if (!byAm.has(am)) byAm.set(am, emptyRow(am));
      const row = byAm.get(am)!;
      row.snooze_ignored.count += 1;
      row.snooze_ignored.entity_ids.push(eid);
    }

    return finalize(byAm);
  } catch (e) {
    console.warn(
      "[coaching] getCoachingPerAm failed:",
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

function finalize(byAm: Map<string, CoachingRow>): CoachingRow[] {
  // Sort by total coaching activity desc, then am_name asc. AMs with all
  // zeros still come back — the UI dims them but keeps them visible so the
  // manager can confirm "nothing falling through" rather than "missing data".
  const rows = Array.from(byAm.values());
  rows.sort((a, b) => {
    const aSum =
      a.red_untouched_7d.count +
      a.stale_red_14d.count +
      a.noreach_streak_3plus.count +
      a.snooze_ignored.count;
    const bSum =
      b.red_untouched_7d.count +
      b.stale_red_14d.count +
      b.noreach_streak_3plus.count +
      b.snooze_ignored.count;
    if (bSum !== aSum) return bSum - aSum;
    return a.am_name.localeCompare(b.am_name);
  });
  return rows;
}
