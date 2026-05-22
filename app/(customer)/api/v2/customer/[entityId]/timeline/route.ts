import { NextRequest, NextResponse } from "next/server";
import {
  readCustomerTrend,
  readCustomerActions,
  getSql,
  readLatestSnapshotV2,
} from "@/lib/customer/postgres";
import { TIER_CUTS } from "@/lib/customer/config";
import type { AmActionRow } from "@/lib/customer/types";
import { getApiUser, requireAmScope, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 30 — Snapshot timeline endpoint.
 *
 * GET /api/v2/customer/:entityId/timeline?days=90
 *   → composite-score timeseries + AM actions + snooze ranges + stoplight
 *     transitions, in a single payload. Powers the inline timeline chart
 *     on the customer-detail page and the full-page /v2/customer/[id]/timeline
 *     standalone view.
 *
 * The "stoplight" derived here is the COMPOSITE-ONLY mapping (composite
 * thresholds from TIER_CUTS). The richer multi-signal stoplight that drives
 * the dashboard is a function of tier + flag_count + billing_score and lives
 * in scoring.ts; for a timeline view we want the simpler composite-derived
 * read so the bands and the line agree visually.
 *
 * Phase 33.B — admin + manager bypass; AMs scoped to customers in their book.
 */

type StoplightT = "RED" | "YELLOW" | "GREEN";

type TimelineComposite = {
  date: string;
  composite: number;
  stoplight: StoplightT;
};

type TimelineAction = {
  id: number;
  date: string;
  iso: string;
  am_name: string;
  action_type: string;
  reason_code: string | null;
  note: string | null;
  composite_at_action: number | null;
};

type TimelineSnooze = {
  snoozed_at: string;
  snoozed_until: string;
  am_name: string;
  reason: string | null;
};

type TimelineTransition = {
  date: string;
  from: StoplightT;
  to: StoplightT;
};

export type TimelineResponse = {
  ok: boolean;
  entity_id: string;
  days: number;
  generated_at: string;
  composite_series: TimelineComposite[];
  actions: TimelineAction[];
  snooze_ranges: TimelineSnooze[];
  stoplight_transitions: TimelineTransition[];
  error?: string;
};

function compositeToStoplight(n: number): StoplightT {
  // Mirrors lib/scoring.ts tier cuts:
  //   composite >= TIER_CUTS.high (65)   → HIGH   → RED
  //   composite >= TIER_CUTS.medium (35) → MEDIUM → YELLOW
  //   otherwise                          → LOW/HEALTHY → GREEN
  if (n >= TIER_CUTS.high) return "RED";
  if (n >= TIER_CUTS.medium) return "YELLOW";
  return "GREEN";
}

function isoToDate(iso: string | undefined | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

/**
 * Soft-fail snooze query — replicates the schema bootstrap inline so we
 * don't have to export ensureSnoozeSchema from lib/snooze.ts.
 */
async function readSnoozeRanges(
  entityId: string,
  days: number,
): Promise<TimelineSnooze[]> {
  const sql = getSql();
  if (!sql) return [];
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS snooze_tracking (
        am_name TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        customer_id TEXT,
        bizname TEXT,
        snoozed_until TIMESTAMPTZ NOT NULL,
        snoozed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reason TEXT,
        PRIMARY KEY (am_name, entity_id)
      )
    `;
    const rows = await sql`
      SELECT am_name, snoozed_at, snoozed_until, reason
      FROM snooze_tracking
      WHERE entity_id = ${entityId}
        AND snoozed_at >= (NOW() - (${days}::int * INTERVAL '1 day'))
      ORDER BY snoozed_at ASC
    `;
    return (rows as Array<{
      am_name: string;
      snoozed_at: string | Date;
      snoozed_until: string | Date;
      reason: string | null;
    }>).map((r) => ({
      am_name: r.am_name,
      snoozed_at:
        typeof r.snoozed_at === "string"
          ? r.snoozed_at
          : r.snoozed_at.toISOString(),
      snoozed_until:
        typeof r.snoozed_until === "string"
          ? r.snoozed_until
          : r.snoozed_until.toISOString(),
      reason: r.reason ?? null,
    }));
  } catch {
    return [];
  }
}

function deriveTransitions(
  series: TimelineComposite[],
): TimelineTransition[] {
  const out: TimelineTransition[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    if (prev.stoplight !== cur.stoplight) {
      out.push({
        date: cur.date,
        from: prev.stoplight,
        to: cur.stoplight,
      });
    }
  }
  return out;
}

export async function GET(
  req: NextRequest,
  ctx: { params: { entityId: string } },
) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  const entityId = ctx.params.entityId;
  const url = new URL(req.url);
  const rawDays = Number(url.searchParams.get("days") || 90);
  const days = Math.max(
    7,
    Math.min(365, Number.isFinite(rawDays) ? rawDays : 90),
  );

  try {
    const snap = await readLatestSnapshotV2();
    if (!snap) {
      return NextResponse.json(
        { ok: false, error: "No snapshot available yet" },
        { status: 503 },
      );
    }
    const customer = snap.customers.find((c) => c.entity_id === entityId);
    if (!customer) {
      return NextResponse.json(
        { ok: false, error: "Customer not found in latest snapshot" },
        { status: 404 },
      );
    }
    const scopeDenied = requireAmScope(user, customer.am_name);
    if (scopeDenied) return scopeDenied;

    const [trendPoints, actionRows, snoozeRanges] = await Promise.all([
      readCustomerTrend(entityId, days),
      readCustomerActions(entityId, 500),
      readSnoozeRanges(entityId, days),
    ]);

    const composite_series: TimelineComposite[] = trendPoints.map((p) => ({
      date: p.date,
      composite: Number(p.composite || 0),
      stoplight: compositeToStoplight(Number(p.composite || 0)),
    }));

    // Filter actions to the requested window
    const cutoffMs = Date.now() - days * 86400_000;
    const actions: TimelineAction[] = (actionRows as AmActionRow[])
      .filter((r) => {
        if (!r.created_at) return false;
        const t = Date.parse(r.created_at);
        return Number.isFinite(t) && t >= cutoffMs;
      })
      .map((r) => ({
        id: Number(r.id || 0),
        date: isoToDate(r.created_at),
        iso: String(r.created_at || ""),
        am_name: r.am_name || "",
        action_type: r.action_type,
        reason_code: (r.reason_code as string | undefined) ?? null,
        note: r.note ?? null,
        composite_at_action:
          r.composite_at_action === undefined || r.composite_at_action === null
            ? null
            : Number(r.composite_at_action),
      }))
      .sort((a, b) =>
        a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0,
      );

    const stoplight_transitions = deriveTransitions(composite_series);

    const payload: TimelineResponse = {
      ok: true,
      entity_id: entityId,
      days,
      generated_at: new Date().toISOString(),
      composite_series,
      actions,
      snooze_ranges: snoozeRanges,
      stoplight_transitions,
    };

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const fallback: TimelineResponse = {
      ok: false,
      entity_id: entityId,
      days,
      generated_at: new Date().toISOString(),
      composite_series: [],
      actions: [],
      snooze_ranges: [],
      stoplight_transitions: [],
      error: msg,
    };
    return NextResponse.json(fallback, { status: 500 });
  }
}
