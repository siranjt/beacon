/**
 * Per-scope context loaders for the AI copilot. Phase E-9.
 *
 * Each scope's loader returns a JSON-serializable context object + an
 * `audience` label for the system prompt. The copilot's universal endpoint
 * dispatches to the right loader based on scope, then renders the context
 * into the prompt.
 *
 * Loaders are server-only — they pull from snapshot, Metabase, Postgres.
 * Each is wrapped with Promise.allSettled style isolation in callers.
 */

import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { fetchEntityReportData } from "@/lib/report/fetchers";
import {
  fetchAllTickets,
  fetchTicketsForCustomer,
} from "@/lib/escalation/tickets";
import {
  listCustomersSinceFloor,
  getCustomer,
} from "@/lib/post-payment/db/queries";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import {
  buildCitationLookup,
  buildCommsPerspectiveCitations,
  type CitationLookup,
  type CommsPerspectiveCitationData,
} from "@/lib/ai/citations";
import {
  readPerspective,
  readPerspectivesForEntities,
  type PerspectiveRow,
} from "@/lib/customer/comms-perspective-store";

/**
 * Phase E-18 — collapse a PerspectiveRow into the lightweight shape the
 * citation helper + context blob both consume. Returning null short-
 * circuits everywhere downstream.
 */
function asCitationPerspective(
  row: PerspectiveRow | null | undefined,
): CommsPerspectiveCitationData | null {
  if (!row) return null;
  return {
    sentiment: row.sentiment,
    topics: row.topics,
    substance_score: row.substance_score,
    initiator_pattern: row.initiator_pattern,
    response_latency_hours: row.response_latency_hours,
  };
}

const AM_BOOK_TOP_N = 80;
const TICKETS_TOP_N = 40;
const POSTPAYMENT_TOP_N = 50;

export interface LoadedContext {
  /** Short header label shown in the AskPanel ("about Skin Spa NYC"). */
  audience: string;
  /** JSON-stringified context blob inserted into the system prompt. */
  blob: string;
  /** Extra metadata captured for telemetry. */
  meta: Record<string, unknown>;
  /**
   * Phase E-17 Wave 3a — citation lookup keyed by `<category>:<id>`. The
   * model sees these keys + values inside CONTEXT under `_citation_lookup`
   * and emits `[cite:KEY]` markers when claiming the underlying fact. The
   * client receives the same lookup via a `citations` SSE frame so it can
   * render the chip tooltip. Scopes without citation support (v1: anything
   * other than customer-360 and customer-book) omit this field.
   */
  citationLookup?: CitationLookup;
}

function findInSnapshot(
  snap: { customers?: ScoredCustomerV2[] } | null,
  entityId: string,
): ScoredCustomerV2 | null {
  if (!snap?.customers) return null;
  return snap.customers.find((c) => c.entity_id === entityId) ?? null;
}

/** ──────────────────────────────────────────────────────────────
 * inbox — uses the same data as the launcher InboxFeed.
 * ────────────────────────────────────────────────────────────── */
export async function loadInboxContext(opts: {
  amFilter: string | null;
}): Promise<LoadedContext> {
  const snap = await readLatestSnapshotV2().catch(() => null);
  const all = (snap?.customers ?? []).filter(
    (c) => c.lifecycle_state !== "recently_churned",
  );
  const scoped = opts.amFilter
    ? all.filter((c) => (c.am_name ?? "") === opts.amFilter)
    : all;

  const red = scoped
    .filter((c) => c.signals_v2?.stoplight === "RED")
    .sort(
      (a, b) =>
        (b.signals_v2?.composite ?? 0) - (a.signals_v2?.composite ?? 0),
    )
    .slice(0, 12);

  const yellow = scoped
    .filter((c) => c.signals_v2?.stoplight === "YELLOW")
    .sort(
      (a, b) =>
        (b.signals_v2?.composite ?? 0) - (a.signals_v2?.composite ?? 0),
    )
    .slice(0, 8);

  // Pull awaiting-AM-call post-payment + open tickets so the inbox copilot
  // can reason across all three sources like the InboxFeed does.
  const [postPayment, tickets] = await Promise.allSettled([
    listCustomersSinceFloor(),
    fetchAllTickets(),
  ]);
  const needsCall =
    postPayment.status === "fulfilled"
      ? postPayment.value
          .filter(
            (c) =>
              c.needs_am_call &&
              c.status === "ready" &&
              c.verdict !== null &&
              (!opts.amFilter || (c.am_name ?? "") === opts.amFilter),
          )
          .slice(0, 10)
      : [];

  const OPEN_STATES = new Set([
    "Todo",
    "In Progress",
    "In Review",
    "Backlog",
  ]);
  const openTickets =
    tickets.status === "fulfilled"
      ? tickets.value
          .filter(
            (t) =>
              OPEN_STATES.has(t.state) &&
              (!opts.amFilter || t.amName === opts.amFilter),
          )
          .slice(0, 12)
      : [];

  // Phase E-9 — additional signal richness for inbox reasoning:
  //   - Outbound-silence buckets so Beacon can answer "who haven't we
  //     contacted in 14d+?" without doing math itself.
  //   - Days-since-last-contact median across RED so Beacon understands
  //     whether silence is the dominant pain or something else is.
  //   - Yesterday's RED count (best-effort, from snapshot history) so it
  //     can comment on day-over-day trend.
  const silent14 = scoped.filter(
    (c) => (c.metrics?.days_since_out ?? 0) >= 14,
  ).length;
  const silent30 = scoped.filter(
    (c) => (c.metrics?.days_since_out ?? 0) >= 30,
  ).length;
  const redSilenceDays = red
    .map((c) => c.metrics?.days_since_out ?? 0)
    .sort((a, b) => a - b);
  const redMedianSilence =
    redSilenceDays.length > 0
      ? redSilenceDays[Math.floor(redSilenceDays.length / 2)]
      : null;

  // Phase E-18 — bulk cache read for critical + watching entities.
  const inboxEntityIds = [
    ...red.map((c) => c.entity_id),
    ...yellow.map((c) => c.entity_id),
    ...needsCall
      .map((c) => c.entity_id ?? null)
      .filter((eid): eid is string => typeof eid === "string" && eid.length > 0),
  ];
  const perspectiveMap = await readPerspectivesForEntities(
    Array.from(new Set(inboxEntityIds)),
  );

  // Phase E-17 Wave 3a.1 — citation lookup for inbox. Mirrors customer-360
  // granularity for the customers actually surfaced in the inbox + ticket
  // entries for the open-ticket sample + aggregate counts.
  const baseCitations = buildCitationLookup({
    kind: "inbox",
    counts: {
      critical: red.length,
      watching: yellow.length,
      needs_am_call: needsCall.length,
      open_tickets: openTickets.length,
    },
    critical: red.map((c) => ({
      entity_id: c.entity_id,
      company: c.company ?? null,
      am_name: c.am_name ?? null,
      composite: c.signals_v2?.composite ?? null,
      stoplight: c.signals_v2?.stoplight ?? null,
      reason: c.signals_v2?.reason_one_line ?? null,
      days_since_in: c.metrics?.days_since_in ?? null,
      days_since_out: c.metrics?.days_since_out ?? null,
      sub_scores: {
        we_silent: c.signals_v2?.sig_we_silent ?? null,
        client_silent: c.signals_v2?.sig_client_silent ?? null,
        response_drop: c.signals_v2?.sig_response_drop ?? null,
        volume_collapse: c.signals_v2?.sig_volume_collapse ?? null,
        usage: c.signals_v2?.sig_usage ?? null,
        billing: c.signals_v2?.sig_billing ?? null,
      },
    })),
    watching: yellow.map((c) => ({
      entity_id: c.entity_id,
      company: c.company ?? null,
      am_name: c.am_name ?? null,
      composite: c.signals_v2?.composite ?? null,
      stoplight: c.signals_v2?.stoplight ?? null,
      reason: c.signals_v2?.reason_one_line ?? null,
      days_since_in: c.metrics?.days_since_in ?? null,
      days_since_out: c.metrics?.days_since_out ?? null,
      sub_scores: {
        we_silent: c.signals_v2?.sig_we_silent ?? null,
        client_silent: c.signals_v2?.sig_client_silent ?? null,
        response_drop: c.signals_v2?.sig_response_drop ?? null,
        volume_collapse: c.signals_v2?.sig_volume_collapse ?? null,
        usage: c.signals_v2?.sig_usage ?? null,
        billing: c.signals_v2?.sig_billing ?? null,
      },
    })),
    openTickets: openTickets.map((t) => ({
      identifier: t.identifier,
      title: t.title,
      classification: t.classification ?? null,
      state: t.state,
      customer: t.customerName ?? null,
      am: t.amName ?? null,
      created_at: t.createdAt,
    })),
  });
  const commsCitations: CitationLookup = {};
  for (const c of [...red, ...yellow]) {
    const persp = perspectiveMap.get(c.entity_id);
    Object.assign(
      commsCitations,
      buildCommsPerspectiveCitations({
        entityId: c.entity_id,
        bizName: c.company ?? null,
        perspective: asCitationPerspective(persp),
      }),
    );
  }
  const citationLookup: CitationLookup = {
    ...baseCitations,
    ...commsCitations,
  };

  const blob = JSON.stringify(
    {
      scope: "inbox",
      _citation_lookup: citationLookup,
      am_filter: opts.amFilter,
      counts: {
        red: scoped.filter((c) => c.signals_v2?.stoplight === "RED").length,
        yellow: scoped.filter((c) => c.signals_v2?.stoplight === "YELLOW").length,
        green: scoped.filter((c) => c.signals_v2?.stoplight === "GREEN").length,
        needs_am_call: needsCall.length,
        open_tickets: openTickets.length,
        outbound_silence_14d: silent14,
        outbound_silence_30d: silent30,
        red_median_days_since_outbound: redMedianSilence,
      },
      critical_customers: red.map((c) => {
        const persp = perspectiveMap.get(c.entity_id);
        return {
          entity_id: c.entity_id,
          biz_name: c.company,
          am_name: c.am_name,
          composite: c.signals_v2?.composite,
          stoplight: c.signals_v2?.stoplight,
          reason: c.signals_v2?.reason_one_line,
          suggested_action: c.signals_v2?.suggested_action,
          days_since_in: c.metrics?.days_since_in,
          days_since_out: c.metrics?.days_since_out,
          comms_perspective: persp
            ? {
                sentiment: persp.sentiment,
                topics: persp.topics,
                substance_score: persp.substance_score,
                initiator_pattern: persp.initiator_pattern,
                response_latency_hours: persp.response_latency_hours,
              }
            : null,
        };
      }),
      watching: yellow.map((c) => {
        const persp = perspectiveMap.get(c.entity_id);
        return {
          entity_id: c.entity_id,
          biz_name: c.company,
          am_name: c.am_name,
          composite: c.signals_v2?.composite,
          reason: c.signals_v2?.reason_one_line,
          comms_perspective: persp
            ? {
                sentiment: persp.sentiment,
                topics: persp.topics,
                substance_score: persp.substance_score,
              }
            : null,
        };
      }),
      needs_am_call: needsCall.map((c) => ({
        cb_customer_id: c.cb_customer_id,
        biz_name: c.biz_name,
        am_name: c.am_name,
        verdict: c.verdict,
        verdict_one_line: c.verdict_one_line,
      })),
      open_tickets_sample: openTickets.map((t) => ({
        identifier: t.identifier,
        title: t.title,
        customer: t.customerName,
        am: t.amName,
        state: t.state,
        created_at: t.createdAt,
      })),
    },
    null,
    2,
  );

  return {
    audience: opts.amFilter ? `${opts.amFilter}'s inbox` : "today's inbox",
    blob,
    meta: {
      am_filter: opts.amFilter,
      red_count: red.length,
      open_tickets: openTickets.length,
    },
    citationLookup,
  };
}

/** ──────────────────────────────────────────────────────────────
 * customer-360 / customer detail — full per-customer data
 * ────────────────────────────────────────────────────────────── */
export async function loadCustomer360Context(entityId: string): Promise<LoadedContext> {
  const snap = await readLatestSnapshotV2().catch(() => null);
  const sc = findInSnapshot(snap, entityId);

  const [perfR, escR, ppR, perspectiveR] = await Promise.allSettled([
    fetchEntityReportData(entityId),
    fetchTicketsForCustomer({ entityId }),
    sc?.customer_id ? getCustomer(sc.customer_id) : Promise.resolve(null),
    readPerspective(entityId),
  ]);

  const perf = perfR.status === "fulfilled" ? perfR.value : null;
  const escalations = escR.status === "fulfilled" ? escR.value : [];
  const postPayment = ppR.status === "fulfilled" ? ppR.value : null;
  const perspective = perspectiveR.status === "fulfilled" ? perspectiveR.value : null;

  // Phase E-17 Wave 3a — build citation lookup ahead of the blob so we can
  // inject the legal-keys map into CONTEXT under `_citation_lookup`. The
  // model sees this and learns which `[cite:KEY]` markers it can emit.
  const performanceForCite = perf
    ? {
        predicted_6_month_leads:
          perf.forecast?.predicted6MonthLeads ?? null,
        review_target: perf.forecast?.reviewTarget ?? null,
        leads_total: perf.leads.length,
        keywords_count: perf.keywords.length,
        keywords_top3: perf.keywords.filter(
          (k) =>
            k.rankCurrent != null && k.rankCurrent > 0 && k.rankCurrent <= 3,
        ).length,
        keywords_top10: perf.keywords.filter(
          (k) =>
            k.rankCurrent != null && k.rankCurrent > 0 && k.rankCurrent <= 10,
        ).length,
      }
    : null;
  const citationLookup: CitationLookup = sc
    ? {
        ...buildCitationLookup({
          kind: "customer-360",
          sc,
          performance: performanceForCite,
          tickets: escalations,
          postPayment: postPayment
            ? {
                verdict: postPayment.verdict,
                needs_am_call: postPayment.needs_am_call,
                verdict_one_line: postPayment.verdict_one_line,
              }
            : null,
        }),
        ...buildCommsPerspectiveCitations({
          entityId,
          bizName: sc.company ?? null,
          perspective: asCitationPerspective(perspective),
        }),
      }
    : {};

  const blob = JSON.stringify(
    {
      scope: "customer-360",
      _citation_lookup: citationLookup,
      identity: {
        entity_id: entityId,
        biz_name: sc?.company ?? null,
        am_name: sc?.am_name ?? null,
        ae_name: sc?.ae_name ?? null,
        cb_customer_id: sc?.customer_id ?? null,
        pod: (sc as { pod?: string } | null)?.pod ?? null,
      },
      signals: sc
        ? {
            composite: sc.signals_v2?.composite,
            tier: sc.signals_v2?.tier,
            stoplight: sc.signals_v2?.stoplight,
            sub_scores: {
              we_silent: sc.signals_v2?.sig_we_silent,
              client_silent: sc.signals_v2?.sig_client_silent,
              response_drop: sc.signals_v2?.sig_response_drop,
              volume_collapse: sc.signals_v2?.sig_volume_collapse,
              usage: sc.signals_v2?.sig_usage,
              billing: sc.signals_v2?.sig_billing,
            },
            flag_performance: sc.signals_v2?.flag_performance,
            flag_tickets: sc.signals_v2?.flag_tickets,
            reason_one_line: sc.signals_v2?.reason_one_line,
            suggested_action: sc.signals_v2?.suggested_action,
            lifecycle_state: sc.lifecycle_state,
            last_any_iso: sc.metrics?.last_any_iso,
            last_in_iso: sc.metrics?.last_in_iso,
            last_out_iso: sc.metrics?.last_out_iso,
            days_since_in: sc.metrics?.days_since_in,
            days_since_out: sc.metrics?.days_since_out,
            channels_used_30d: sc.metrics?.channels_used_30d,
            channels_used_90d: sc.metrics?.channels_used_90d,
            total_30d: sc.metrics?.total_30d,
            total_90d: sc.metrics?.total_90d,
            trajectory_7d: sc.signals_v2?.trajectory_7d,
          }
        : null,
      performance: perf
        ? {
            vertical: perf.identity.verticalDisplay ?? perf.identity.vertical,
            city: perf.identity.city,
            state: perf.identity.state,
            gbp_clicks_last_3_months: perf.gbpClicks
              .slice(-3)
              .map((m) => ({ month: m.month, clicks: m.profileClicks })),
            keywords_count: perf.keywords.length,
            keywords_top3: perf.keywords.filter(
              (k) =>
                k.rankCurrent != null && k.rankCurrent > 0 && k.rankCurrent <= 3,
            ).length,
            keywords_top10: perf.keywords.filter(
              (k) =>
                k.rankCurrent != null && k.rankCurrent > 0 && k.rankCurrent <= 10,
            ).length,
            leads_total: perf.leads.length,
            predicted_6_month_leads: perf.forecast?.predicted6MonthLeads ?? null,
            review_target: perf.forecast?.reviewTarget ?? null,
          }
        : null,
      escalations:
        escalations.length > 0
          ? {
              open: escalations
                .filter((t) =>
                  ["Todo", "In Progress", "In Review", "Backlog"].includes(
                    t.state,
                  ),
                )
                .slice(0, 8)
                .map((t) => ({
                  identifier: t.identifier,
                  title: t.title,
                  state: t.state,
                  classification: t.classification,
                  created_at: t.createdAt,
                })),
              closed_30d_count: escalations.filter((t) => {
                if (!["Done", "Canceled", "Duplicate"].includes(t.state))
                  return false;
                const c = t.completedAt || t.cancelledAt;
                if (!c) return false;
                const t0 = Date.parse(c);
                return Number.isFinite(t0) && Date.now() - t0 < 30 * 86_400_000;
              }).length,
            }
          : null,
      post_payment: postPayment
        ? {
            status: postPayment.status,
            verdict: postPayment.verdict,
            needs_am_call: postPayment.needs_am_call,
            verdict_one_line: postPayment.verdict_one_line,
            key_flags: postPayment.key_flags,
            booking_platform: postPayment.booking_platform,
            primary_category: postPayment.primary_category,
            predicted_6_month_leads: postPayment.predicted_6_month_leads,
            cb_created_at: postPayment.cb_created_at,
            updated_at: postPayment.updated_at,
          }
        : null,
      // Phase E-18 — Haiku-derived comms perspective (90-day window).
      // null when no perspective row exists yet for this entity — the AM
      // hasn't opened the customer detail page since the table was
      // populated. Don't fabricate sentiment from absence.
      comms_perspective: perspective
        ? {
            sentiment: perspective.sentiment,
            topics: perspective.topics,
            substance_score: perspective.substance_score,
            initiator_pattern: perspective.initiator_pattern,
            response_latency_hours: perspective.response_latency_hours,
            haiku_summary: perspective.haiku_summary,
            conversation_arcs: perspective.conversation_arcs,
            computed_at: perspective.computed_at,
          }
        : null,
    },
    null,
    2,
  );

  return {
    audience: sc?.company ?? entityId,
    blob,
    meta: {
      entity_id: entityId,
      biz_name: sc?.company ?? null,
      cb_customer_id: sc?.customer_id ?? null,
    },
    citationLookup,
  };
}

/** ──────────────────────────────────────────────────────────────
 * customer-book — aggregate over the AM's book (or whole org)
 * ────────────────────────────────────────────────────────────── */
export async function loadCustomerBookContext(opts: {
  amFilter: string | null;
}): Promise<LoadedContext> {
  const snap = await readLatestSnapshotV2().catch(() => null);
  const all = (snap?.customers ?? []).filter(
    (c) => c.lifecycle_state !== "recently_churned",
  );
  const scoped = opts.amFilter
    ? all.filter((c) => (c.am_name ?? "") === opts.amFilter)
    : all;

  // Sort by composite desc → top N most-at-risk surface in the prompt
  const sorted = [...scoped].sort(
    (a, b) =>
      (b.signals_v2?.composite ?? 0) - (a.signals_v2?.composite ?? 0),
  );
  const top = sorted.slice(0, AM_BOOK_TOP_N);

  const counts = {
    total: scoped.length,
    red: scoped.filter((c) => c.signals_v2?.stoplight === "RED").length,
    yellow: scoped.filter((c) => c.signals_v2?.stoplight === "YELLOW").length,
    green: scoped.filter((c) => c.signals_v2?.stoplight === "GREEN").length,
  };

  // Trajectory rollup (7d delta)
  const worsening = scoped.filter(
    (c) => c.signals_v2?.trajectory_7d === "worsening",
  ).length;
  const improving = scoped.filter(
    (c) => c.signals_v2?.trajectory_7d === "improving",
  ).length;

  // Phase E-9 — sharper signal rollup so Beacon can reason about WHY the
  // book is in its state, not just count the stoplights.
  // 1. Median composite (book-level health proxy)
  // 2. Sub-score distribution across RED customers (where's the dominant pain?)
  // 3. Outbound-silence stat (how many customers haven't been contacted in 14d+)
  // 4. Channel-mix diversity over the book
  const composites = scoped
    .map((c) => c.signals_v2?.composite)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  const median =
    composites.length > 0
      ? composites[Math.floor(composites.length / 2)]
      : null;

  const redSubScores = scoped
    .filter((c) => c.signals_v2?.stoplight === "RED")
    .reduce(
      (acc, c) => {
        const s = c.signals_v2;
        if (!s) return acc;
        acc.we_silent += s.sig_we_silent ?? 0;
        acc.client_silent += s.sig_client_silent ?? 0;
        acc.response_drop += s.sig_response_drop ?? 0;
        acc.volume_collapse += s.sig_volume_collapse ?? 0;
        acc.usage += s.sig_usage ?? 0;
        acc.billing += s.sig_billing ?? 0;
        acc.n += 1;
        return acc;
      },
      {
        we_silent: 0,
        client_silent: 0,
        response_drop: 0,
        volume_collapse: 0,
        usage: 0,
        billing: 0,
        n: 0,
      },
    );
  const red_avg_sub_scores =
    redSubScores.n > 0
      ? {
          we_silent: Math.round(redSubScores.we_silent / redSubScores.n),
          client_silent: Math.round(redSubScores.client_silent / redSubScores.n),
          response_drop: Math.round(redSubScores.response_drop / redSubScores.n),
          volume_collapse: Math.round(redSubScores.volume_collapse / redSubScores.n),
          usage: Math.round(redSubScores.usage / redSubScores.n),
          billing: Math.round(redSubScores.billing / redSubScores.n),
        }
      : null;

  const silent_14d_count = scoped.filter(
    (c) => (c.metrics?.days_since_out ?? 0) >= 14,
  ).length;
  const silent_30d_count = scoped.filter(
    (c) => (c.metrics?.days_since_out ?? 0) >= 30,
  ).length;

  // Phase E-18 — bulk cache read for the top-at-risk customers. Cache-only;
  // never triggers Haiku from the AI ask path.
  const perspectiveMap = await readPerspectivesForEntities(
    top.map((c) => c.entity_id),
  );

  // Phase E-17 Wave 3a — citation lookup for the book scope. Counts +
  // per-row composites/days-since for everything we surface in `top_at_risk`.
  const baseCitations = buildCitationLookup({
    kind: "customer-book",
    counts,
    trajectory: { worsening, improving },
    health: {
      median_composite: median ?? null,
      outbound_silence_14d: silent_14d_count,
      outbound_silence_30d: silent_30d_count,
    },
    topAtRisk: top.map((c) => ({
      entity_id: c.entity_id,
      company: c.company ?? null,
      composite: c.signals_v2?.composite ?? null,
      stoplight: c.signals_v2?.stoplight ?? null,
      reason: c.signals_v2?.reason_one_line ?? null,
      days_since_in: c.metrics?.days_since_in ?? null,
      days_since_out: c.metrics?.days_since_out ?? null,
    })),
  });
  const commsCitations: CitationLookup = {};
  for (const c of top) {
    const persp = perspectiveMap.get(c.entity_id);
    Object.assign(
      commsCitations,
      buildCommsPerspectiveCitations({
        entityId: c.entity_id,
        bizName: c.company ?? null,
        perspective: asCitationPerspective(persp),
      }),
    );
  }
  const citationLookup: CitationLookup = { ...baseCitations, ...commsCitations };

  const blob = JSON.stringify(
    {
      scope: "customer-book",
      _citation_lookup: citationLookup,
      am_filter: opts.amFilter,
      counts,
      trajectory: { worsening, improving },
      health_summary: {
        median_composite: median,
        red_avg_sub_scores,
        outbound_silence_14d: silent_14d_count,
        outbound_silence_30d: silent_30d_count,
      },
      top_at_risk: top.map((c) => {
        const persp = perspectiveMap.get(c.entity_id);
        return {
          entity_id: c.entity_id,
          biz_name: c.company,
          am_name: c.am_name,
          composite: c.signals_v2?.composite,
          stoplight: c.signals_v2?.stoplight,
          tier: c.signals_v2?.tier,
          reason: c.signals_v2?.reason_one_line,
          suggested: c.signals_v2?.suggested_action,
          trajectory: c.signals_v2?.trajectory_7d,
          days_since_in: c.metrics?.days_since_in,
          days_since_out: c.metrics?.days_since_out,
          // Phase E-18 — light perspective subset for top-at-risk rows.
          comms_perspective: persp
            ? {
                sentiment: persp.sentiment,
                topics: persp.topics,
                substance_score: persp.substance_score,
                initiator_pattern: persp.initiator_pattern,
                response_latency_hours: persp.response_latency_hours,
              }
            : null,
        };
      }),
    },
    null,
    2,
  );

  return {
    audience: opts.amFilter ? `${opts.amFilter}'s book` : "the whole book",
    blob,
    meta: {
      am_filter: opts.amFilter,
      total_customers: counts.total,
      red_count: counts.red,
    },
    citationLookup,
  };
}

/** ──────────────────────────────────────────────────────────────
 * performance-landing — no per-customer data; just product knowledge
 * ────────────────────────────────────────────────────────────── */
export async function loadPerformanceLandingContext(): Promise<LoadedContext> {
  // Mostly conceptual surface. We surface a tiny set of aggregate
  // metrics (total active book, median composite) the AI can ground
  // light-touch comparisons in; recent-reports is client-side only so
  // we skip it here.
  const snap = await readLatestSnapshotV2().catch(() => null);
  const all = (snap?.customers ?? []).filter(
    (c) => c.lifecycle_state !== "recently_churned",
  );
  const composites = all
    .map((c) => c.signals_v2?.composite)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  const median =
    composites.length > 0
      ? composites[Math.floor(composites.length / 2)]
      : null;

  const citationLookup: CitationLookup = buildCitationLookup({
    kind: "performance-landing",
    total_active_customers: all.length,
    // Reports-generated-this-week lives in localStorage on the client
    // (see PerformanceLanding's recent_reports). Server has no view of
    // it — leave null so the entry is skipped.
    reports_generated_this_week: null,
    median_composite_score: median,
  });

  const blob = JSON.stringify(
    {
      scope: "performance-landing",
      _citation_lookup: citationLookup,
      note:
        "User is on the Performance Beacon landing page. They haven't picked a customer yet. They're likely asking conceptual questions about how Performance Beacon works, what its metrics mean, or how to interpret a typical report.",
      counts: {
        total_active_customers: all.length,
      },
      health_summary: {
        median_composite_score: median,
      },
    },
    null,
    2,
  );
  return {
    audience: "Performance Beacon",
    blob,
    meta: { scope: "performance-landing", total_active_customers: all.length },
    citationLookup,
  };
}

/** ──────────────────────────────────────────────────────────────
 * performance-report — single customer's performance data
 * ────────────────────────────────────────────────────────────── */
export async function loadPerformanceReportContext(
  entityId: string,
): Promise<LoadedContext> {
  // Same as customer-360 but trimmed to just performance + identity.
  // Easier to maintain than two parallel queries.
  const snap = await readLatestSnapshotV2().catch(() => null);
  const sc = findInSnapshot(snap, entityId);

  const [perfR, perspectiveR] = await Promise.allSettled([
    fetchEntityReportData(entityId),
    readPerspective(entityId),
  ]);
  const perf = perfR.status === "fulfilled" ? perfR.value : null;
  const perspective =
    perspectiveR.status === "fulfilled" ? perspectiveR.value : null;

  // Phase E-17 Wave 3a.1 — derive citation-friendly performance numbers.
  // Peak/current/dip computed on the full available series (the loader
  // already includes the in-progress month — surfaced separately to the
  // model via gbp_clicks_last_6_months). Per the project memory, peak/dip
  // should be computed on COMPLETE months only — we treat all but the
  // last month as complete; the last-month entry is the in-progress one.
  let gbpClicksCurrent: { month: string; clicks: number } | null = null;
  let gbpClicksPeak: { month: string; clicks: number } | null = null;
  let gbpDipPct: number | null = null;
  if (perf && perf.gbpClicks.length > 0) {
    const series = perf.gbpClicks;
    const lastIdx = series.length - 1;
    const currentEntry = series[lastIdx];
    gbpClicksCurrent = {
      month: currentEntry.month,
      clicks: currentEntry.profileClicks,
    };
    const completed = series.slice(0, lastIdx);
    if (completed.length > 0) {
      const peakEntry = completed.reduce((acc, m) =>
        m.profileClicks > acc.profileClicks ? m : acc,
      );
      gbpClicksPeak = {
        month: peakEntry.month,
        clicks: peakEntry.profileClicks,
      };
      if (peakEntry.profileClicks > 0) {
        gbpDipPct =
          ((currentEntry.profileClicks - peakEntry.profileClicks) /
            peakEntry.profileClicks) *
          100;
      }
    }
  }
  const topKeywords = perf
    ? perf.keywords
        .filter(
          (k) =>
            typeof k.rankCurrent === "number" &&
            k.rankCurrent !== null &&
            k.rankCurrent > 0,
        )
        .sort((a, b) => (a.rankCurrent ?? 999) - (b.rankCurrent ?? 999))
        .slice(0, 3)
        .map((k) => ({
          keyword: k.keyword,
          rank: k.rankCurrent ?? null,
        }))
    : [];
  const activeKeywordRankings = perf
    ? perf.keywords.filter(
        (k) => typeof k.rankCurrent === "number" && k.rankCurrent !== null,
      ).length
    : 0;
  // Year-to-date leads — count leads with createdAt in the current calendar year.
  const currentYear = new Date().getUTCFullYear();
  const ytdLeads = perf
    ? perf.leads.filter((l) => {
        const t = Date.parse(l.createdAt ?? "");
        if (!Number.isFinite(t)) return false;
        return new Date(t).getUTCFullYear() === currentYear;
      }).length
    : 0;

  const citationLookup: CitationLookup = {
    ...buildCitationLookup({
      kind: "performance-report",
      entity_id: entityId,
      ytd_leads: perf ? ytdLeads : null,
      predicted_6_month_leads: perf?.forecast?.predicted6MonthLeads ?? null,
      gbp_clicks_current: gbpClicksCurrent,
      gbp_clicks_peak: gbpClicksPeak,
      gbp_dip_pct: gbpDipPct,
      active_keyword_rankings: activeKeywordRankings,
      top_keywords: topKeywords,
      review_target: perf?.forecast?.reviewTarget ?? null,
      // EntityReportData doesn't carry reviews aggregates yet — leave null so
      // the entries are skipped.
      reviews_total: null,
      reviews_avg_rating: null,
    }),
    ...buildCommsPerspectiveCitations({
      entityId,
      bizName: sc?.company ?? perf?.identity?.title ?? null,
      perspective: asCitationPerspective(perspective),
    }),
  };

  const blob = JSON.stringify(
    {
      scope: "performance-report",
      _citation_lookup: citationLookup,
      identity: {
        entity_id: entityId,
        biz_name: sc?.company ?? perf?.identity?.title ?? null,
        vertical: perf?.identity?.verticalDisplay ?? perf?.identity?.vertical ?? null,
        city: perf?.identity?.city ?? null,
        state: perf?.identity?.state ?? null,
      },
      performance: perf
        ? {
            gbp_clicks_last_6_months: perf.gbpClicks
              .slice(-6)
              .map((m) => ({ month: m.month, clicks: m.profileClicks })),
            keywords: perf.keywords
              .slice(0, 30)
              .map((k) => ({
                keyword: k.keyword,
                rank_current: k.rankCurrent,
                rank_best: k.rankBest,
                rank_when_joined: k.rankWhenJoined,
              })),
            leads_total: perf.leads.length,
            leads_last_30d: perf.leads.filter((l) => {
              const t = Date.parse(l.createdAt ?? "");
              return Number.isFinite(t) && Date.now() - t < 30 * 86_400_000;
            }).length,
            lead_source_mix: (() => {
              const mix: Record<string, number> = {};
              for (const l of perf.leads) {
                const k = l.utmSource ?? l.source ?? "(unknown)";
                mix[k] = (mix[k] ?? 0) + 1;
              }
              return mix;
            })(),
            forecast: {
              predicted_6_month_leads:
                perf.forecast?.predicted6MonthLeads ?? null,
              with_zoca_6_month_profile_clicks:
                perf.forecast?.withZoca6MonthProfileClicks ?? null,
              without_zoca_6_month_profile_clicks:
                perf.forecast?.withoutZoca6MonthProfileClicks ?? null,
              review_target: perf.forecast?.reviewTarget ?? null,
            },
          }
        : null,
      // Phase E-18 — Haiku-derived comms perspective alongside the
      // performance metrics. Lets the AI reason about whether SEO wins
      // are landing in a warm relationship or a tense one.
      comms_perspective: perspective
        ? {
            sentiment: perspective.sentiment,
            topics: perspective.topics,
            substance_score: perspective.substance_score,
            initiator_pattern: perspective.initiator_pattern,
            response_latency_hours: perspective.response_latency_hours,
            haiku_summary: perspective.haiku_summary,
          }
        : null,
    },
    null,
    2,
  );

  return {
    audience: sc?.company ?? perf?.identity?.title ?? entityId,
    blob,
    meta: { entity_id: entityId, biz_name: sc?.company ?? null },
    citationLookup,
  };
}

/** ──────────────────────────────────────────────────────────────
 * escalation-overview — open tickets queue + recent
 * ────────────────────────────────────────────────────────────── */
export async function loadEscalationOverviewContext(): Promise<LoadedContext> {
  const tickets = await fetchAllTickets().catch(() => []);
  const OPEN_STATES = new Set([
    "Todo",
    "In Progress",
    "In Review",
    "Backlog",
  ]);
  const open = tickets.filter((t) => OPEN_STATES.has(t.state));
  const closed7d = tickets.filter((t) => {
    if (!["Done", "Canceled", "Duplicate"].includes(t.state)) return false;
    const c = t.completedAt || t.cancelledAt;
    if (!c) return false;
    const t0 = Date.parse(c);
    return Number.isFinite(t0) && Date.now() - t0 < 7 * 86_400_000;
  }).length;

  // Group counts by AM + classification.
  const byAm: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  for (const t of open) {
    byAm[t.amName ?? "(unknown)"] = (byAm[t.amName ?? "(unknown)"] ?? 0) + 1;
    byClass[t.classification ?? "(unknown)"] =
      (byClass[t.classification ?? "(unknown)"] ?? 0) + 1;
  }

  const ageOf = (iso: string): number | null => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
  };
  const aged14 = open.filter((t) => (ageOf(t.createdAt) ?? 0) >= 14).length;
  const aged30 = open.filter((t) => (ageOf(t.createdAt) ?? 0) >= 30).length;

  const topTickets = open
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, TICKETS_TOP_N);

  // Phase E-18 — bulk-fetch perspectives for the customers attached to
  // surfaced tickets. Cache-only; skip if entity_id is missing on the
  // ticket (the older v1 feed didn't carry it on every row).
  const escEntityIds = Array.from(
    new Set(
      topTickets
        .map((t) => t.entityId)
        .filter((eid): eid is string => typeof eid === "string" && eid.length > 0),
    ),
  );
  const perspectiveMap = await readPerspectivesForEntities(escEntityIds);

  const baseCitations = buildCitationLookup({
    kind: "escalation-overview",
    open_total: open.length,
    by_am: byAm,
    by_classification: byClass,
    aged_14d_plus: aged14,
    aged_30d_plus: aged30,
    tickets: topTickets.map((t) => ({
      identifier: t.identifier,
      title: t.title,
      classification: t.classification ?? null,
      state: t.state,
      customer: t.customerName ?? null,
      am: t.amName ?? null,
      created_at: t.createdAt,
      age_days: ageOf(t.createdAt),
    })),
  });
  const commsCitations: CitationLookup = {};
  for (const t of topTickets) {
    if (!t.entityId) continue;
    const persp = perspectiveMap.get(t.entityId);
    Object.assign(
      commsCitations,
      buildCommsPerspectiveCitations({
        entityId: t.entityId,
        bizName: t.customerName ?? null,
        perspective: asCitationPerspective(persp),
      }),
    );
  }
  const citationLookup: CitationLookup = {
    ...baseCitations,
    ...commsCitations,
  };

  const blob = JSON.stringify(
    {
      scope: "escalation-overview",
      _citation_lookup: citationLookup,
      counts: {
        open_total: open.length,
        closed_last_7d: closed7d,
      },
      by_am: byAm,
      by_classification: byClass,
      open_sample: open
        .slice(0, TICKETS_TOP_N)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map((t) => {
          const persp = t.entityId
            ? perspectiveMap.get(t.entityId)
            : undefined;
          return {
            identifier: t.identifier,
            title: t.title,
            state: t.state,
            customer: t.customerName,
            am: t.amName,
            classification: t.classification,
            created_at: t.createdAt,
            age_days: Math.floor(
              (Date.now() - Date.parse(t.createdAt)) / 86_400_000,
            ),
            // Phase E-18 — sentiment + topics on the customer behind this
            // ticket. Helps AI distinguish "stalled ticket on a warm
            // account" from "stalled ticket on an already-escalating one".
            comms_perspective: persp
              ? {
                  sentiment: persp.sentiment,
                  topics: persp.topics,
                  substance_score: persp.substance_score,
                }
              : null,
          };
        }),
    },
    null,
    2,
  );

  return {
    audience: "the escalation queue",
    blob,
    meta: { open_total: open.length },
    citationLookup,
  };
}

/** ──────────────────────────────────────────────────────────────
 * post-payment-book — recent verdicts list
 * ────────────────────────────────────────────────────────────── */
export async function loadPostPaymentBookContext(): Promise<LoadedContext> {
  const customers = await listCustomersSinceFloor().catch(() => []);
  const slice = customers.slice(0, POSTPAYMENT_TOP_N);

  const counts = {
    total: customers.length,
    icp: customers.filter((c) => c.verdict === "icp").length,
    review: customers.filter((c) => c.verdict === "review").length,
    not_icp: customers.filter((c) => c.verdict === "not_icp").length,
    pending: customers.filter((c) => c.verdict === null && c.status !== "failed").length,
    failed: customers.filter((c) => c.status === "failed").length,
    needs_am_call: customers.filter((c) => c.needs_am_call).length,
  };

  // Plan label derived from the first sub item price id (best-effort);
  // first-payment amount comes from sub_total_cents.
  const pickPlan = (priceIds: string[] | null): string | null => {
    if (!priceIds || priceIds.length === 0) return null;
    return priceIds[0] ?? null;
  };

  // Phase E-18 — bulk-fetch perspectives for surfaced post-payment customers.
  // Cache-only; only customers with a resolved entity_id are eligible (BaseSheet
  // sync may still be pending for net-new rows — see `pending_entity` status).
  const ppEntityIds = Array.from(
    new Set(
      slice
        .map((c) => c.entity_id)
        .filter((eid): eid is string => typeof eid === "string" && eid.length > 0),
    ),
  );
  const perspectiveMap = await readPerspectivesForEntities(ppEntityIds);

  const baseCitations = buildCitationLookup({
    kind: "post-payment-book",
    counts: {
      icp: counts.icp,
      review: counts.review,
      not_icp: counts.not_icp,
      needs_am_call: counts.needs_am_call,
    },
    customers: slice.map((c) => ({
      cb_customer_id: c.cb_customer_id,
      biz_name: c.biz_name,
      verdict: c.verdict,
      plan: pickPlan(c.sub_item_price_ids),
      first_payment_amount_cents: c.sub_total_cents,
    })),
  });
  const commsCitations: CitationLookup = {};
  for (const c of slice) {
    if (!c.entity_id) continue;
    const persp = perspectiveMap.get(c.entity_id);
    Object.assign(
      commsCitations,
      buildCommsPerspectiveCitations({
        entityId: c.entity_id,
        bizName: c.biz_name ?? null,
        perspective: asCitationPerspective(persp),
      }),
    );
  }
  const citationLookup: CitationLookup = {
    ...baseCitations,
    ...commsCitations,
  };

  const blob = JSON.stringify(
    {
      scope: "post-payment-book",
      _citation_lookup: citationLookup,
      counts,
      recent: slice.map((c) => {
        const persp = c.entity_id
          ? perspectiveMap.get(c.entity_id)
          : undefined;
        return {
          cb_customer_id: c.cb_customer_id,
          biz_name: c.biz_name,
          am_name: c.am_name,
          ae_name: c.ae_name,
          status: c.status,
          verdict: c.verdict,
          needs_am_call: c.needs_am_call,
          verdict_one_line: c.verdict_one_line,
          key_flags: c.key_flags,
          booking_platform: c.booking_platform,
          primary_category: c.primary_category,
          predicted_6_month_leads: c.predicted_6_month_leads,
          cb_created_at: c.cb_created_at,
          updated_at: c.updated_at,
          comms_perspective: persp
            ? {
                sentiment: persp.sentiment,
                topics: persp.topics,
                substance_score: persp.substance_score,
              }
            : null,
        };
      }),
    },
    null,
    2,
  );

  return {
    audience: "recent post-payment reviews",
    blob,
    meta: { total: customers.length },
    citationLookup,
  };
}

/** ──────────────────────────────────────────────────────────────
 * post-payment-customer — single review
 * ────────────────────────────────────────────────────────────── */
export async function loadPostPaymentCustomerContext(
  cbCustomerId: string,
): Promise<LoadedContext> {
  const c = await getCustomer(cbCustomerId);
  if (!c) {
    return {
      audience: cbCustomerId,
      blob: JSON.stringify(
        { scope: "post-payment-customer", not_found: cbCustomerId },
        null,
        2,
      ),
      meta: { cb_customer_id: cbCustomerId, not_found: true },
      citationLookup: {},
    };
  }
  const plan = c.sub_item_price_ids?.[0] ?? null;
  // Phase E-18 — perspective when the entity has been resolved + cached.
  const perspective = c.entity_id ? await readPerspective(c.entity_id) : null;
  const citationLookup: CitationLookup = {
    ...buildCitationLookup({
      kind: "post-payment-customer",
      cb_customer_id: c.cb_customer_id,
      biz_name: c.biz_name,
      verdict: c.verdict,
      verdict_one_line: c.verdict_one_line,
      plan,
      first_payment_amount_cents: c.sub_total_cents,
      key_flags: c.key_flags,
    }),
    ...(c.entity_id
      ? buildCommsPerspectiveCitations({
          entityId: c.entity_id,
          bizName: c.biz_name ?? null,
          perspective: asCitationPerspective(perspective),
        })
      : {}),
  };
  const blob = JSON.stringify(
    {
      scope: "post-payment-customer",
      _citation_lookup: citationLookup,
      cb_customer_id: c.cb_customer_id,
      entity_id: c.entity_id ?? null,
      comms_perspective: perspective
        ? {
            sentiment: perspective.sentiment,
            topics: perspective.topics,
            substance_score: perspective.substance_score,
            initiator_pattern: perspective.initiator_pattern,
            response_latency_hours: perspective.response_latency_hours,
            haiku_summary: perspective.haiku_summary,
          }
        : null,
      biz_name: c.biz_name,
      am_name: c.am_name,
      ae_name: c.ae_name,
      status: c.status,
      verdict: c.verdict,
      needs_am_call: c.needs_am_call,
      verdict_one_line: c.verdict_one_line,
      key_flags: c.key_flags,
      booking_platform: c.booking_platform,
      booking_platform_active: c.booking_platform_active,
      primary_category: c.primary_category,
      predicted_6_month_leads: c.predicted_6_month_leads,
      total_monthly_revenue: c.total_monthly_revenue,
      open_tickets_30d: c.open_tickets_30d,
      churn_potential_flag: c.churn_potential_flag,
      total_reviews_at_onb: c.total_reviews_at_onb,
      avg_rating_at_onb: c.avg_rating_at_onb,
      five_star_reviews: c.five_star_reviews,
      cb_created_at: c.cb_created_at,
      updated_at: c.updated_at,
    },
    null,
    2,
  );
  return {
    audience: c.biz_name ?? cbCustomerId,
    blob,
    meta: { cb_customer_id: cbCustomerId, biz_name: c.biz_name },
    citationLookup,
  };
}
