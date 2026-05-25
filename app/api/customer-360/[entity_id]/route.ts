/**
 * Customer 360 aggregator — Phase E-9.
 *
 * GET /api/customer-360/{entity_id}
 *
 * Pulls a single customer's data from all four agents in parallel and
 * returns one shaped payload for the /360 page:
 *
 *   - Customer Beacon signals: from latest dashboard_snapshot (composite,
 *     stoplight, sub-scores, lifecycle state, last comms)
 *   - Performance Beacon metrics: via existing fetchEntityReportData()
 *     (GBP clicks monthly, keyword rankings, leads, forecast). Returns
 *     null if Metabase doesn't have a row.
 *   - Escalation tickets: via existing fetchTicketsForCustomer({ entityId })
 *     (open + recently closed Linear tickets for the entity)
 *   - Post-Payment verdict: via getCustomer(cb_customer_id) — cb_customer_id
 *     comes from the snapshot row. Returns null if customer was never
 *     analyzed (most book customers).
 *
 * Per-source errors are isolated — a broken Performance fetch doesn't
 * blank the whole response. Each source returns `null` + an entry in
 * `errors` so the UI can show a per-section retry instead of failing the
 * whole page.
 *
 * Auth: any signed-in zoca user. The data exposed is no more sensitive
 * than what each agent already surfaces individually.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { fetchEntityReportData } from "@/lib/report/fetchers";
import { fetchTicketsForCustomer, type MetabaseTicket } from "@/lib/escalation/tickets";
import { getCustomer, type Customer as PostPaymentCustomer } from "@/lib/post-payment/db/queries";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import type { EntityReportData } from "@/lib/report/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface MetaBlock {
  entity_id: string;
  biz_name: string;
  am_name: string | null;
  ae_name: string | null;
  cb_customer_id: string | null;
  pod: string | null;
  // Generated_at of the underlying Customer Beacon snapshot (oldest data
  // point in the aggregate; useful for the page-level freshness indicator).
  snapshot_generated_at: string | null;
  // When THIS aggregator response was produced.
  generated_at: string;
}

interface SignalsBlock {
  composite: number;
  tier: "HIGH" | "MEDIUM" | "LOW" | "HEALTHY";
  stoplight: "RED" | "YELLOW" | "GREEN";
  sub_scores: {
    we_silent: number;
    client_silent: number;
    response_drop: number;
    volume_collapse: number;
    usage: number;
    billing: number;
  };
  flag_performance: boolean;
  flag_tickets: boolean;
  reason_one_line: string;
  suggested_action: string;
  lifecycle_state: ScoredCustomerV2["lifecycle_state"] | undefined;
  last_any_iso: string | null;
  last_in_iso: string | null;
  last_out_iso: string | null;
  trajectory_7d: "improving" | "worsening" | "stable" | "unknown";
}

interface PerformanceBlock {
  vertical: string;
  city: string | null;
  state: string | null;
  // Current month not necessarily complete — surface separately so callers
  // can show "vs peak full month" instead of comparing apples to oranges.
  current_month_clicks: number | null;
  current_month: string | null;
  peak_month_clicks: number | null;
  peak_month: string | null;
  dip_pct_complete_months: number | null;
  active_keywords_count: number;
  top3_keywords_count: number;
  top10_keywords_count: number;
  ytd_leads: number;
  predicted_6_month_leads: number | null;
  weekly_review_target: number | null;
}

interface EscalationBlock {
  open_count: number;
  open_recent: Array<{
    id: string;
    identifier: string;
    title: string;
    url: string;
    state: string;
    created_at: string;
    age_days: number;
  }>;
  closed_30d_count: number;
}

interface PostPaymentBlock {
  cb_customer_id: string;
  status: PostPaymentCustomer["status"];
  verdict: "icp" | "review" | "not_icp" | null;
  needs_am_call: boolean;
  verdict_one_line: string | null;
  key_flags: string[] | null;
  report_docx_url: string | null;
  cb_created_at: string;
  updated_at: string;
}

interface Customer360Response {
  meta: MetaBlock;
  signals: SignalsBlock | null;
  performance: PerformanceBlock | null;
  escalation: EscalationBlock | null;
  post_payment: PostPaymentBlock | null;
  errors: Record<string, string>;
}

function ageDays(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/** Pick the row for our entity out of the snapshot's customers array. */
function findInSnapshot(
  snap: { customers?: ScoredCustomerV2[] } | null,
  entityId: string,
): ScoredCustomerV2 | null {
  if (!snap?.customers) return null;
  return snap.customers.find((c) => c.entity_id === entityId) ?? null;
}

function lastMonthFromGbp(
  gbp: EntityReportData["gbpClicks"] | null | undefined,
): { peak: { month: string; clicks: number } | null; current: { month: string; clicks: number } | null; dip: number | null } {
  if (!gbp || gbp.length === 0) return { peak: null, current: null, dip: null };
  const sorted = [...gbp].sort((a, b) => a.month.localeCompare(b.month));
  const current = sorted[sorted.length - 1];

  // "Complete months" filter — drop the current calendar month if we're not
  // far enough into it to compare safely. Heuristic: complete months only.
  const today = new Date();
  const currentMonthKey = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const completeOnly = sorted.filter((m) => m.month < currentMonthKey);

  if (completeOnly.length === 0) {
    return {
      peak: null,
      current: current
        ? { month: current.month, clicks: current.profileClicks }
        : null,
      dip: null,
    };
  }
  const peak = completeOnly.reduce((acc, m) =>
    m.profileClicks > acc.profileClicks ? m : acc,
  );
  const lastComplete = completeOnly[completeOnly.length - 1];
  const dip =
    peak.profileClicks > 0
      ? Math.round(
          ((peak.profileClicks - lastComplete.profileClicks) /
            peak.profileClicks) *
            100,
        )
      : null;

  return {
    peak: { month: peak.month, clicks: peak.profileClicks },
    current: current
      ? { month: current.month, clicks: current.profileClicks }
      : null,
    dip,
  };
}

export async function GET(
  _req: Request,
  ctx: { params: { entity_id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const entityId = ctx.params.entity_id;
  if (!entityId) {
    return NextResponse.json({ error: "missing entity_id" }, { status: 400 });
  }

  const errors: Record<string, string> = {};

  // Step 1: read snapshot so we know who this customer is (bizname,
  // cb_customer_id, am, signals). Without this we can't render the hero
  // or call post-payment, so this step is REQUIRED — bail if it fails.
  const snap = await readLatestSnapshotV2().catch((e: unknown) => {
    errors.snapshot = e instanceof Error ? e.message : String(e);
    return null;
  });

  const sc = findInSnapshot(snap, entityId);
  // If snapshot is missing/empty OR entity isn't in it, we still want to
  // try the other sources by entity_id — the customer might exist in
  // Performance/Escalation/Post-Payment but not in the current Customer
  // Beacon scope (recently churned, pre-launch, etc).
  const cbCustomerId = sc?.customer_id ?? null;
  const bizName = sc?.company ?? null;

  // Step 2: parallel fetch from the other three agents.
  const [perfR, escR, ppR] = await Promise.allSettled([
    fetchEntityReportData(entityId),
    fetchTicketsForCustomer({ entityId }),
    cbCustomerId ? getCustomer(cbCustomerId) : Promise.resolve(null),
  ]);

  // ---- Customer Beacon signals -------------------------------------------
  let signals: SignalsBlock | null = null;
  if (sc?.signals_v2) {
    const s = sc.signals_v2;
    signals = {
      composite: Math.round(s.composite ?? 0),
      tier: s.tier,
      stoplight: s.stoplight,
      sub_scores: {
        we_silent: Math.round(s.sig_we_silent ?? 0),
        client_silent: Math.round(s.sig_client_silent ?? 0),
        response_drop: Math.round(s.sig_response_drop ?? 0),
        volume_collapse: Math.round(s.sig_volume_collapse ?? 0),
        usage: Math.round(s.sig_usage ?? 0),
        billing: Math.round(s.sig_billing ?? 0),
      },
      flag_performance: !!s.flag_performance,
      flag_tickets: !!s.flag_tickets,
      reason_one_line: s.reason_one_line ?? "",
      suggested_action: s.suggested_action ?? "",
      lifecycle_state: sc.lifecycle_state,
      last_any_iso: sc.metrics?.last_any_iso ?? null,
      last_in_iso: sc.metrics?.last_in_iso ?? null,
      last_out_iso: sc.metrics?.last_out_iso ?? null,
      trajectory_7d: s.trajectory_7d,
    };
  }

  // ---- Performance ------------------------------------------------------
  let performance: PerformanceBlock | null = null;
  if (perfR.status === "fulfilled" && perfR.value) {
    const d = perfR.value;
    const { peak, current, dip } = lastMonthFromGbp(d.gbpClicks);
    const top3 = d.keywords.filter(
      (k) => k.rankCurrent != null && k.rankCurrent > 0 && k.rankCurrent <= 3,
    ).length;
    const top10 = d.keywords.filter(
      (k) => k.rankCurrent != null && k.rankCurrent > 0 && k.rankCurrent <= 10,
    ).length;
    const ytdLeads = d.leads.filter((l) => {
      const t = Date.parse(l.createdAt ?? "");
      return Number.isFinite(t) && new Date(t).getUTCFullYear() === new Date().getUTCFullYear();
    }).length;
    performance = {
      vertical: d.identity.verticalDisplay ?? d.identity.vertical,
      city: d.identity.city,
      state: d.identity.state,
      current_month_clicks: current?.clicks ?? null,
      current_month: current?.month ?? null,
      peak_month_clicks: peak?.clicks ?? null,
      peak_month: peak?.month ?? null,
      dip_pct_complete_months: dip,
      active_keywords_count: d.keywords.length,
      top3_keywords_count: top3,
      top10_keywords_count: top10,
      ytd_leads: ytdLeads,
      predicted_6_month_leads: d.forecast?.predicted6MonthLeads ?? null,
      weekly_review_target: d.forecast?.reviewTarget ?? null,
    };
  } else if (perfR.status === "rejected") {
    errors.performance = perfR.reason instanceof Error ? perfR.reason.message : String(perfR.reason);
  }

  // ---- Escalation -------------------------------------------------------
  let escalation: EscalationBlock | null = null;
  if (escR.status === "fulfilled") {
    const tickets: MetabaseTicket[] = escR.value;
    const OPEN_STATES = new Set(["Todo", "In Progress", "In Review", "Backlog"]);
    const open = tickets.filter((t) => OPEN_STATES.has(t.state));
    const closed30 = tickets.filter((t) => {
      if (t.state !== "Done" && t.state !== "Canceled" && t.state !== "Duplicate") return false;
      const c = t.completedAt || t.cancelledAt;
      if (!c) return false;
      const t0 = Date.parse(c);
      if (!Number.isFinite(t0)) return false;
      return Date.now() - t0 < 30 * 86_400_000;
    });
    escalation = {
      open_count: open.length,
      open_recent: open
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 6)
        .map((t) => ({
          id: t.id,
          identifier: t.identifier || t.id.slice(0, 8),
          title: t.title || "(untitled)",
          url: t.url,
          state: t.state,
          created_at: t.createdAt,
          age_days: ageDays(t.createdAt),
        })),
      closed_30d_count: closed30.length,
    };
  } else {
    errors.escalation = escR.reason instanceof Error ? escR.reason.message : String(escR.reason);
  }

  // ---- Post-Payment -----------------------------------------------------
  let post_payment: PostPaymentBlock | null = null;
  if (ppR.status === "fulfilled" && ppR.value) {
    const c = ppR.value;
    post_payment = {
      cb_customer_id: c.cb_customer_id,
      status: c.status,
      verdict: c.verdict,
      needs_am_call: !!c.needs_am_call,
      verdict_one_line: c.verdict_one_line,
      key_flags: c.key_flags,
      report_docx_url: c.report_blob_docx_url,
      cb_created_at: c.cb_created_at,
      updated_at: c.updated_at,
    };
  } else if (ppR.status === "rejected") {
    errors.post_payment = ppR.reason instanceof Error ? ppR.reason.message : String(ppR.reason);
  }

  // Determine "pod" using either snapshot field or POD_MAP from config.
  // Snapshot already attaches `pod` for v2-shaped customers.
  const pod = (sc as unknown as { pod?: string })?.pod ?? null;

  const body: Customer360Response = {
    meta: {
      entity_id: entityId,
      biz_name: bizName ?? "Unknown customer",
      am_name: sc?.am_name ?? null,
      ae_name: sc?.ae_name ?? null,
      cb_customer_id: cbCustomerId,
      pod: pod || null,
      snapshot_generated_at: snap?.generatedAt ?? null,
      generated_at: new Date().toISOString(),
    },
    signals,
    performance,
    escalation,
    post_payment,
    errors,
  };

  return NextResponse.json(body, {
    headers: {
      // Per-customer view, lightly cached. Performance fetches dominate
      // the time budget; this cache keeps the page snappy on reload.
      "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
    },
  });
}
