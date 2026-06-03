import { fetchAllLiveSubsWithEntityMap } from "./chargebee";
import { fetchPlaceIdsForEntities } from "./metabase-place-id";
import { fetchUnpaidInvoices, fetchRecentTransactions, buildBillingMetrics, scoreBilling } from "./billing";
import { fetchBaseSheet } from "./metabase";
import { fetchUsageMetrics, scoreUsage } from "./mixpanel";
import { fetchPerformanceMetrics } from "./performance";
import { computeMetrics, scoreCustomer, computeTicketsFlag, composeHybridSignals } from "./scoring";
import { writeSnapshotV2, readSnapshotByDate, writeCustomerTrendRows } from "./postgres";
import { enrichRedNarratives } from "./narrative-enrich";
import {
  fetchActiveHubspotCompanies,
  type HubspotCompanyRow,
} from "./hubspot-companies";
import { fetchDealsForCompanies, type DealsForCompany } from "./hubspot-deals";
import { fetchCallsForCompanies, type CallsForCompany } from "./hubspot-calls";
import { fetchContactsForCompanies, type CompanyContact } from "./hubspot-contacts";
import {
  fetchEnrichedNotesPerCompany,
  fetchLatestNotePerCompany,
  type LastCallSummary,
} from "./hubspot-notes";
import { readNoteEnrichments, writeNoteEnrichments, type CachedNoteEnrichment } from "./postgres";
import { readPipelineStage } from "./pipeline-state";
import {
  writePipelineStage,
  readAllPipelineStages,
  todaySnapshotDate,
} from "./pipeline-state";
import {
  TIER_ORDER,
  EXCLUDED_ENTITIES,
  POD_MAP,
  TICKETS_MAX_RECORDS_PER_CUSTOMER,
  pgConfigured,
} from "./config";
// Phase 31.v2 — single Metabase CSV per nightly refresh (replaces v1 HubSpot
// Service Hub + Linear GraphQL adapters).
import { fetchTicketsFromMetabase } from "./tickets-from-metabase";
// Phase E-11 — integrity alerting on stage-level failures.
import { postSlack } from "./slack";
import type { UnifiedTicket } from "./tickets-unified";
import type {
  ScoredCustomer,
  ScoredCustomerV2,
  Snapshot,
  SnapshotV2,
  CommsEvent,
  BaseSheetRow,
  AmTierRow,
  PodTierRow,
  DataHealth,
  ChargebeeSub,
  ChargebeeInvoice,
  ChargebeeTransaction,
  CustomerMetrics,
  UsageMetrics,
  PerformanceMetrics,
  BillingMetrics,
  TicketsMetrics,
} from "./types";
import type { Tier, Stoplight } from "./config";

import { getHealthCardMap } from "@/lib/customer/health-card";
// Phase E-19 Wave 1 — dual-source comms ingest (V2 path).
import { fetchBulkCommsEvents, fetchBulkCommsEventsStreaming } from "./comms-bulk-fetch";
import {
  upsertCommsEvents,
  getEventsForEntities,
  deriveCustomerMetricsFromEvents,
  writeWatermarks,
  type CommsEventRow,
} from "./comms-events-store";
const todayMs = () => Date.now();

// ---------------------------------------------------------------------------
// Stage data shapes — what gets serialized to Postgres pipeline_state.data
// ---------------------------------------------------------------------------

export type StageAData = {
  todayMs: number;
  todayIso: string;
  activeEntityIds: string[];
  customerToEntities: Record<string, string[]>;
  entityMeta: Record<string, {
    customer_id: string;
    subscription_id: string;
    sub_status: string;
    plan_amount_cents: number;
    auto_collection: string | null;
    company_from_chargebee: string;
    // Phase 33.scope-fix7 — entity-specific name from Chargebee sub.cf_entity_name.
    entity_name_from_chargebee: string;
    email: string;
    phone: string;
    activated_at: string | null;
    place_id: string | null;
  }>;
  baseSheetByEntityId: Record<string, BaseSheetRow>;
  /** Phase 33.scope — Chargebee subs cancelled within last 30d, keyed by customer_id. */
  recentlyChurnedByCustomer?: Record<string, { subscription_id: string; cancelled_at: string | null; activated_at: string | null; }>;
  billingMetrics: Record<string, BillingMetrics>;
  stats: {
    totalSubs: number;
    totalInvoices: number;
    totalTransactions: number;
    baseSheetRowCount: number;
    excludedCount: number;
    multiEntityExpansion: number;
    placeIdsResolved: number;
  };
};

export type StageBData = {
  commsMetricsByEntity: Record<string, CustomerMetrics>;
  /**
   * Phase 14B: per-entity, per-channel event count for the last 30 days.
   * Used by compose to derive HubSpot vs. Metabase calls drift on phone.
   * Shape: entityId -> { chat, email, phone, video, sms }.
   */
  channelCounts30dByEntity: Record<string, Record<string, number>>;
  commsStats: {
    rawRows: Record<string, number>;
    eventsKept: Record<string, number>;
    eventsDeduped: Record<string, number>;
    totalDuplicatesRemoved: number;
  };
  perSourceEventCount: Record<string, number>;
  perDirectionCount: { in: number; out: number };
  channelCounts: { d30: Record<string, number>; d90: Record<string, number> };
};

/**
 * Phase E-19 Wave 1 W1.8 — V2 comms metrics, stored in a SEPARATE pipeline
 * state slot (stage='B2') from V1's Stage B. V1 and V2 run in distinct
 * Vercel function instances to keep their memory budgets independent —
 * pre-split, running both in one function OOMed at 3GB.
 *
 * Owned by /api/cron/refresh/stage-b-v2 route, written by runStageBV2.
 */
export type StageB2Data = {
  commsMetricsByEntityV2: Record<string, CustomerMetrics>;
  v2Diagnostics: {
    eventCount: number;
    entitiesWithEventsV2: number;
    fetchDurationMs: number;
    upsertDurationMs: number;
    deriveDurationMs: number;
    softFailReason: string | null;
  };
};

export type StageCData = {
  usageMetricsByEntity: Record<string, UsageMetrics>;
  performanceMetricsByEntity: Record<string, PerformanceMetrics>;
  diagnostics: {
    mixpanelRowCount: number;
    performanceRowCounts: {
      gbpClicksMonthly: number;
      rankings: number;
      reviews12w: number;
      locationInsights: number;
      bookingEnquiries: number;
    };
  };
};

export type HubspotCompanyByPlaceId = {
  place_id: string;
  hubspot_company_id: string;
  name: string;
  icp_tier: "Tier 1" | "Tier 2" | "Tier 3" | null;
  lifecycle_stage: string;
  business_category: string | null;
};

export type StageDData = {
  companiesByPlaceId: Record<string, HubspotCompanyByPlaceId>;
  dealsByHubspotCompanyId: Record<string, DealsForCompany>;
  notesByHubspotCompanyId: Record<string, LastCallSummary>;
  /** Phase 14B (Tier C) — 30d call counts per HubSpot company */
  callsByHubspotCompanyId?: Record<string, CallsForCompany>;
  /** Phase 14C (Tier E) — top contacts per HubSpot company */
  contactsByHubspotCompanyId?: Record<string, CompanyContact[]>;
  diagnostics: {
    totalCompanies: number;
    companiesWithDeals: number;
    companiesWithRecentNotes: number;
    companiesWithCalls: number;
    companiesWithContacts: number;
    notesEnrichedNew: number;
    notesEnrichedCached: number;
  };
};

// ---------------------------------------------------------------------------
// Memory checkpoint helper
// ---------------------------------------------------------------------------

function memSnap(label: string): void {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  console.log(
    `[mem ${label}] rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB external=${mb(m.external)}MB`,
  );
}

/**
 * Phase 14.2 — per-fetcher timing wrapper for Stage D.
 * Logs `[stageD] <label> OK in Xms` on success and `FAILED in Xms` on error,
 * then re-throws so existing .catch() handlers (which translate errors into
 * empty Maps + push to errors[]) still run. This gives us per-call visibility
 * inside the Promise that previously failed silently inside the catch block.
 */
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    console.log(`[stageD] ${label} OK in ${Date.now() - t0}ms`);
    return result;
  } catch (e) {
    console.warn(
      `[stageD] ${label} FAILED in ${Date.now() - t0}ms:`,
      e instanceof Error ? e.message : String(e),
    );
    throw e;
  }
}

// ===========================================================================
// STAGE A — Chargebee subs/invoices/transactions + BaseSheet + billing
// ===========================================================================

export async function runStageA(today: number = todayMs()): Promise<{
  data: StageAData;
  durationMs: number;
  errors: string[];
}> {
  const started = Date.now();
  const errors: string[] = [];
  memSnap("A start");

  // Stage A fetches in parallel — these are all small payloads.
  const [cbResult, invoicesResult, transactionsResult, baseSheetResult] = await Promise.all([
    fetchAllLiveSubsWithEntityMap().catch((e: Error) => {
      errors.push(`Chargebee subs: ${e.message}`);
      // Phase 33.scope-fix7-hotfix — keep the success and failure return shapes identical
      // so the destructure below doesn't hit a TS union-type error.
      return { subs: [] as ChargebeeSub[], customerToEntities: new Map<string, string[]>(), entityNameById: new Map<string, string>() };
    }),
    fetchUnpaidInvoices().catch((e: Error) => {
      errors.push(`Chargebee invoices: ${e.message}`);
      return [] as ChargebeeInvoice[];
    }),
    fetchRecentTransactions().catch((e: Error) => {
      errors.push(`Chargebee transactions: ${e.message}`);
      return [] as ChargebeeTransaction[];
    }),
    fetchBaseSheet().catch((e: Error) => {
      errors.push(`BaseSheet: ${e.message}`);
      return {
        rows: [] as BaseSheetRow[],
        byCustomerId: {} as Record<string, BaseSheetRow>,
        byCustomerIdMulti: {} as Record<string, BaseSheetRow[]>,
        byEntityId: {} as Record<string, BaseSheetRow>,
        byBizName: {} as Record<string, BaseSheetRow>,
      };
    }),
  ]);
  memSnap("A after fetch");

  // Phase 33.scope-fix7 — also pick up the per-entity name map.
  const { subs, customerToEntities, entityNameById } = cbResult;
  const customerToEntitiesObj: Record<string, string[]> = {};
  for (const [k, v] of customerToEntities) customerToEntitiesObj[k] = v;

  // Build active-entity universe — Chargebee cf_entity_id, minus exclude list
  const activeEntityIds = new Set<string>();
  let excludedCount = 0;
  for (const [, entIds] of customerToEntities) {
    for (const eid of entIds) {
      if (EXCLUDED_ENTITIES[eid]) excludedCount++;
      else activeEntityIds.add(eid);
    }
  }

  // Multi-entity expansion count (informational)
  let multiEntityExpansion = 0;
  for (const [, entIds] of customerToEntities) {
    if (entIds.length > 1) multiEntityExpansion += entIds.length - 1;
  }

  // Per-entity metadata (joining Chargebee sub fields)
  const entityMeta: StageAData["entityMeta"] = {};
  const entityToCustomer = new Map<string, string>();
  for (const [cid, entIds] of customerToEntities) {
    for (const eid of entIds) entityToCustomer.set(eid, cid);
  }
  const subsByCustomer = new Map<string, ChargebeeSub>();
  for (const s of subs) {
    if (!s.customer_id) continue;
    // Phase 33.scope-fix2 — prefer live subs over cancelled, and prefer
    // "active" over other live statuses (non_renewing, in_trial, future).
    const existing = subsByCustomer.get(s.customer_id);
    if (!existing) {
      subsByCustomer.set(s.customer_id, s);
    } else if (existing.status === "cancelled" && s.status !== "cancelled") {
      subsByCustomer.set(s.customer_id, s);
    } else if (s.status === "active" && existing.status !== "active") {
      subsByCustomer.set(s.customer_id, s);
    }
  }
  // Resolve entity_id -> place_id via Aurora (Phase 14A). When METABASE_API_KEY
  // is unset (dev/CI), this returns an empty Map and every entityMeta entry
  // gets place_id: null — the HubSpot join falls back to bizname cleanly.
  const placeIdByEntity = await fetchPlaceIdsForEntities(Array.from(activeEntityIds)).catch(
    (e: Error) => {
      errors.push(`Metabase place_id: ${e.message}`);
      return new Map<string, string>();
    },
  );

  for (const eid of activeEntityIds) {
    const cid = entityToCustomer.get(eid) || "";
    const sub = subsByCustomer.get(cid);
    entityMeta[eid] = {
      customer_id: cid,
      subscription_id: sub?.subscription_id || "",
      sub_status: sub?.status || "",
      plan_amount_cents: sub?.plan_amount || 0,
      auto_collection: sub?.auto_collection || null,
      company_from_chargebee: sub?.company || "",
      // Phase 33.scope-fix7 — fall back to entity-specific Chargebee name for the UI/Slack bizname.
      entity_name_from_chargebee: entityNameById.get(eid) || "",
      email: sub?.email || "",
      phone: sub?.phone || "",
      activated_at: sub?.activated_at ? new Date(sub.activated_at).toISOString() : null,
      place_id: placeIdByEntity.get(eid) || null,
    };
  }

  // Billing metrics keyed by entity_id
  const billingMap = buildBillingMetrics(invoicesResult, transactionsResult, subs, customerToEntities);
  const billingMetrics: Record<string, BillingMetrics> = {};
  for (const [eid, m] of billingMap) billingMetrics[eid] = m;

  // BaseSheet by entity_id (only active entities — drop rest)
  const baseSheetByEntityId: Record<string, BaseSheetRow> = {};
  for (const eid of activeEntityIds) {
    const row = baseSheetResult.byEntityId[eid];
    if (row) baseSheetByEntityId[eid] = row;
  }

  memSnap("A end");
  // Phase 33.scope — separate the cancelled-<30d bag from the live universe.
  const recentlyChurnedByCustomer: Record<string, { subscription_id: string; cancelled_at: string | null; activated_at: string | null }> = {};
  const liveCustomerIds = new Set<string>();
  for (const s of subs) {
    if (!(s as any).recently_cancelled && s.customer_id) liveCustomerIds.add(s.customer_id);
  }
  for (const s of subs) {
    if (!(s as any).recently_cancelled) continue;
    if (!s.customer_id) continue;
    // Phase 33.scope-fix5 — DO NOT skip resurrected here. We need their
    // cancelled_at to flow into recentlyChurnedByCustomer so the lifecycle
    // derivation can tag them as "resurrected" (was "active" until now).
    const existing = recentlyChurnedByCustomer[s.customer_id];
    const cancelledMs = (s as any).cancelled_at as number | null | undefined;
    if (!existing || (cancelledMs && (!existing.cancelled_at || Date.parse(existing.cancelled_at) < cancelledMs))) {
      recentlyChurnedByCustomer[s.customer_id] = {
        subscription_id: s.subscription_id || "",
        cancelled_at: cancelledMs ? new Date(cancelledMs).toISOString() : null,
        activated_at: s.activated_at ? new Date(s.activated_at).toISOString() : null,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Phase E-11 — Stage A integrity assertions (G4).
  // Sentinel checks that catch silent-failure modes where Chargebee returns
  // a partial response (missing recently_cancelled marker, drastically smaller
  // customer universe than yesterday, etc.). Each finding pushes a structured
  // "integrity:" error so composeSnapshot lifts it into degraded_reasons →
  // the UI staleness banner. Severe findings also fire Slack + Sentry.
  // -------------------------------------------------------------------------
  const assertions: { token: string; severity: "warn" | "alert"; message: string }[] = [];

  // A.1 — universe shrank suspiciously. Active book is typically 800-1000.
  // <500 is a strong "something broke" signal.
  if (activeEntityIds.size < 500 && errors.length === 0) {
    assertions.push({
      token: `integrity:stage_a_universe_shrank_to_${activeEntityIds.size}`,
      severity: "alert",
      message: `Active customer universe shrank to ${activeEntityIds.size}. Expected 800-1000. Possible Chargebee fetch issue.`,
    });
  }

  // A.2 — recently_cancelled marker missing. If we got plenty of live subs but
  // ZERO recently-churned entries, Chargebee likely dropped the `recently_cancelled`
  // tag — meaning real churn is invisible right now. This was the exact silent
  // failure mode from the audit.
  const recentlyChurnedCount = Object.keys(recentlyChurnedByCustomer).length;
  if (subs.length >= 100 && recentlyChurnedCount === 0) {
    assertions.push({
      token: "integrity:stage_a_recently_cancelled_field_missing",
      severity: "alert",
      message:
        `Stage A returned ${subs.length} subs but ZERO recently_cancelled — Chargebee response shape may have changed. ` +
        `Churn is currently invisible.`,
    });
  }

  // A.3 — BaseSheet collapsed. The match overlay needs BaseSheet; <100 rows
  // means the public CSV fetch is partial.
  if (baseSheetResult.rows.length < 100) {
    assertions.push({
      token: `integrity:stage_a_basesheet_only_${baseSheetResult.rows.length}_rows`,
      severity: "warn",
      message: `BaseSheet returned only ${baseSheetResult.rows.length} rows. Expected 900+. AM/AE/pod mapping will be incomplete.`,
    });
  }

  // A.4 — place_id resolution collapsed. <50% coverage on active customers
  // means HubSpot company joins will whiff. Soft-warn only — the dashboard
  // still works without HubSpot data.
  if (placeIdByEntity.size > 0 && placeIdByEntity.size < activeEntityIds.size * 0.5) {
    assertions.push({
      token: `integrity:stage_a_place_id_coverage_${Math.floor((placeIdByEntity.size / Math.max(activeEntityIds.size, 1)) * 100)}pct`,
      severity: "warn",
      message: `place_id resolved for only ${placeIdByEntity.size} of ${activeEntityIds.size} active customers. HubSpot joins will be partial.`,
    });
  }

  // Emit findings → errors[] for composeSnapshot to lift into degraded_reasons.
  for (const a of assertions) {
    errors.push(a.token);
    console.warn(`[stage-a integrity ${a.severity}] ${a.message}`);
  }

  // Fire-and-forget Slack alert + Sentry capture for severe findings. Never
  // block the snapshot pipeline on alerting — these are observability outputs.
  const alerts = assertions.filter((a) => a.severity === "alert");
  if (alerts.length > 0) {
    try {
      // Lazy Sentry — see SectionErrorBoundary for the same pattern. If
      // @sentry/nextjs isn't installed (local dev), this no-ops cleanly.
      const Sentry = require("@sentry/nextjs");
      for (const a of alerts) {
        if (Sentry?.captureMessage) {
          Sentry.captureMessage(a.message, {
            level: "error",
            tags: { kind: "stage_a_integrity", token: a.token },
          });
        }
      }
    } catch {
      /* Sentry not installed — fine */
    }
    // Slack post is fire-and-forget; we don't await so we don't slow the cron.
    postSlack({
      text: `:rotating_light: *Beacon Stage A integrity*: ${alerts.length} alert(s)`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: ":rotating_light: Beacon — Stage A integrity alerts" },
        },
        ...alerts.map((a) => ({
          type: "section",
          text: { type: "mrkdwn", text: `*${a.token}*\n${a.message}` },
        })),
      ],
    }).catch(() => {
      /* never crash the pipeline on Slack hiccups */
    });
  }

  const data: StageAData = {
    todayMs: today,
    todayIso: new Date(today).toISOString(),
    activeEntityIds: Array.from(activeEntityIds).sort(),
    customerToEntities: customerToEntitiesObj,
    entityMeta,
    baseSheetByEntityId,
    recentlyChurnedByCustomer,
    billingMetrics,
    stats: {
      totalSubs: subs.length,
      totalInvoices: invoicesResult.length,
      totalTransactions: transactionsResult.length,
      baseSheetRowCount: baseSheetResult.rows.length,
      excludedCount,
      multiEntityExpansion,
      placeIdsResolved: placeIdByEntity.size,
    },
  };
  return { data, durationMs: Date.now() - started, errors };
}

// ===========================================================================
// STAGE B — Comms (5 CSVs) → per-entity comms metrics
// ===========================================================================

/**
 * Phase E-19 W2 (Cutover) — Stage B now ingests from the bulk-events Metabase
 * question via the chunked Dataset API (lib/customer/comms-bulk-fetch.ts),
 * not the legacy 5-CSV pipeline. V1's fetchAllCommsSequential + computeMetrics
 * + groupCommsByEntity are retired as of this commit because:
 *   1. V1's 1.6M-row in-memory buffer OOMed even at 3GB.
 *   2. V2 ran cleanly with 972 entity metrics, ~245s wall time at 3GB.
 *   3. V1's 5-CSV exports were stale anyway (4-hour timestamp drift vs Postgres).
 *
 * The cutover preserves the StageBData shape so composeSnapshot, the v2
 * dashboard, and the HubSpot phone-drift detection (Phase 14B) all keep
 * working without changes. Comms-stats fields that were CSV-specific
 * (rawRows / eventsKept / eventsDeduped) are filled with V2's per-channel
 * event counts as a reasonable equivalent.
 *
 * Stage A's activeEntityIds is required — if Stage A hasn't run, we return
 * an empty StageBData with errors[] populated. The cron schedule guarantees
 * Stage A runs before Stage B.
 */
export async function runStageB(
  today: number = todayMs(),
  activeEntityIds: string[] = [],
): Promise<{
  data: StageBData;
  durationMs: number;
  errors: string[];
}> {
  const started = Date.now();
  const errors: string[] = [];
  memSnap("B start");

  // Empty universe → empty result with error. Composer will surface in degraded_reasons.
  if (activeEntityIds.length === 0) {
    errors.push("runStageB: no activeEntityIds — Stage A likely hasn't run");
    return {
      data: {
        commsMetricsByEntity: {},
        channelCounts30dByEntity: {},
        commsStats: {
          rawRows: { chat: 0, email: 0, phone: 0, video: 0, sms: 0 },
          eventsKept: { chat: 0, email: 0, phone: 0, video: 0, sms: 0 },
          eventsDeduped: { chat: 0, email: 0, phone: 0, video: 0, sms: 0 },
          totalDuplicatesRemoved: 0,
        },
        perSourceEventCount: { chat: 0, email: 0, phone: 0, video: 0, sms: 0 },
        perDirectionCount: { in: 0, out: 0 },
        channelCounts: { d30: {}, d90: {} },
      },
      durationMs: Date.now() - started,
      errors,
    };
  }

  // Phase E-19 follow-up (#336) — stream fetch + upsert chunk-by-chunk
  // so peak memory stays bounded to one chunk at a time instead of
  // holding the union of all chunks in RAM. Per-source + per-direction
  // counters tally inline during the stream (cheap O(1) per row) so we
  // don't need a flat array later. After streaming completes, re-read
  // the upserted rows from Postgres for the per-entity derivation —
  // one extra DB query, but means the heaviest in-memory state is the
  // final byEntity Map, not the chunked fetch overhead on top.
  let totalEventsFetched = 0;
  const perSourceEventCount = { chat: 0, email: 0, phone: 0, video: 0, sms: 0 } as Record<string, number>;
  const perDirectionCount = { in: 0, out: 0 };
  try {
    const result = await fetchBulkCommsEventsStreaming(
      activeEntityIds,
      90,
      async (chunkEvents: CommsEventRow[]) => {
        // Tally diagnostic counters on the way through — saves an extra
        // pass over the final 60k-row array later.
        for (const e of chunkEvents) {
          perSourceEventCount[e.channel] = (perSourceEventCount[e.channel] || 0) + 1;
          if (e.direction === "inbound") perDirectionCount.in++;
          else if (e.direction === "outbound") perDirectionCount.out++;
        }
        // Upsert this chunk immediately. If Postgres backpressures,
        // the fetcher pauses naturally (the worker awaits this).
        try {
          await upsertCommsEvents(chunkEvents);
        } catch (e: any) {
          errors.push(`Comms (V2 upsert chunk): ${e.message}`);
        }
      },
    );
    totalEventsFetched = result.totalEvents;
  } catch (e: any) {
    errors.push(`Comms (V2 bulk stream): ${e.message}`);
  }
  memSnap(`B after streamed fetch+upsert (${totalEventsFetched} events)`);

  // Re-read from Postgres for the per-entity derivation. The streamed
  // upsert wrote the canonical rows; this read gives us the same data
  // already deduped + bounded by the 90d window via SQL.
  const byEntity = await getEventsForEntities(activeEntityIds, 90).catch(
    (e: Error) => {
      errors.push(`Comms (V2 readback): ${e.message}`);
      return new Map<string, CommsEventRow[]>();
    },
  );
  memSnap(`B after readback (${byEntity.size} entities)`);

  // Derive per-entity metrics
  const commsMetricsByEntity: Record<string, CustomerMetrics> = {};
  const channelCounts30dByEntity: Record<string, Record<string, number>> = {};
  const cutoff30d = today - 30 * 86400 * 1000;
  const now = new Date(today);

  for (const eid of activeEntityIds) {
    const evs = byEntity.get(eid) || [];
    commsMetricsByEntity[eid] = deriveCustomerMetricsFromEvents(evs, now);
    const perCh: Record<string, number> = { chat: 0, email: 0, phone: 0, video: 0, sms: 0 };
    for (const e of evs) {
      const t = Date.parse(e.created_at);
      if (Number.isFinite(t) && t >= cutoff30d) {
        perCh[e.channel] = (perCh[e.channel] || 0) + 1;
      }
    }
    channelCounts30dByEntity[eid] = perCh;
  }
  memSnap("B after metrics");

  // perSourceEventCount + perDirectionCount were tallied inline during
  // the streamed fetch above (search "Phase E-19 follow-up (#336)").
  // No second pass over a flat array needed.

  // Channel counts across active book (d30/d90 distinct customers per channel)
  const channelCounts = { d30: {} as Record<string, number>, d90: {} as Record<string, number> };
  for (const m of Object.values(commsMetricsByEntity)) {
    for (const ch of (m.channels_used_30d || "").split(",").filter(Boolean)) {
      channelCounts.d30[ch] = (channelCounts.d30[ch] || 0) + 1;
    }
    for (const ch of (m.channels_used_90d || "").split(",").filter(Boolean)) {
      channelCounts.d90[ch] = (channelCounts.d90[ch] || 0) + 1;
    }
  }

  // Watermarks (per-entity last_event_at + 90d count) — keeps freshness
  // banner working on customer cards.
  const watermarks: Array<{
    entity_id: string;
    last_event_at: string | null;
    event_count_90d: number;
  }> = [];
  for (const eid of activeEntityIds) {
    const evs = byEntity.get(eid) || [];
    const last = evs.length > 0
      ? evs.reduce((acc, e) => (e.created_at > acc ? e.created_at : acc), evs[0].created_at)
      : null;
    watermarks.push({ entity_id: eid, last_event_at: last, event_count_90d: evs.length });
  }
  await writeWatermarks(watermarks).catch((e: Error) => {
    console.warn(`[stageB] watermark write soft-failed: ${e.message}`);
  });

  memSnap("B end");
  const data: StageBData = {
    commsMetricsByEntity,
    channelCounts30dByEntity,
    // V1's commsStats fields were CSV-row-level counts; V2 doesn't have those.
    // Use V2's per-channel event counts as the closest equivalent so anything
    // reading these fields for diagnostics gets a non-zero meaningful value.
    commsStats: {
      rawRows: { ...perSourceEventCount } as { chat: number; email: number; phone: number; video: number; sms: number },
      eventsKept: { ...perSourceEventCount } as { chat: number; email: number; phone: number; video: number; sms: number },
      eventsDeduped: { chat: 0, email: 0, phone: 0, video: 0, sms: 0 },
      totalDuplicatesRemoved: 0,
    },
    perSourceEventCount,
    perDirectionCount,
    channelCounts,
  };

  console.log(
    `[stageB] V2 ingest complete in ${Date.now() - started}ms — ` +
      `events=${totalEventsFetched}, entities_with_events=${byEntity.size}/${activeEntityIds.length}`,
  );
  return { data, durationMs: Date.now() - started, errors };
}

// ===========================================================================
// STAGE C — Mixpanel + performance cards → per-entity usage + perf metrics
// ===========================================================================

export async function runStageC(today: number = todayMs()): Promise<{
  data: StageCData;
  durationMs: number;
  errors: string[];
}> {
  const started = Date.now();
  const errors: string[] = [];
  memSnap("C start");

  const [usageResult, perfResult] = await Promise.all([
    fetchUsageMetrics(today).catch((e: Error) => {
      errors.push(`Mixpanel: ${e.message}`);
      return { metrics: new Map<string, UsageMetrics>(), rowCount: 0 };
    }),
    fetchPerformanceMetrics().catch((e: Error) => {
      errors.push(`Performance: ${e.message}`);
      return {
        metrics: new Map<string, PerformanceMetrics>(),
        rowCounts: { gbpClicksMonthly: 0, rankings: 0, reviews12w: 0, locationInsights: 0, bookingEnquiries: 0 },
      };
    }),
  ]);
  memSnap("C after fetch");

  const usageMetricsByEntity: Record<string, UsageMetrics> = {};
  for (const [eid, m] of usageResult.metrics) usageMetricsByEntity[eid] = m;

  const performanceMetricsByEntity: Record<string, PerformanceMetrics> = {};
  for (const [eid, m] of perfResult.metrics) performanceMetricsByEntity[eid] = m;

  memSnap("C end");
  const data: StageCData = {
    usageMetricsByEntity,
    performanceMetricsByEntity,
    diagnostics: {
      mixpanelRowCount: usageResult.rowCount,
      performanceRowCounts: perfResult.rowCounts,
    },
  };
  return { data, durationMs: Date.now() - started, errors };
}

// ===========================================================================
// STAGE D — HubSpot companies + deals + Fireflies note enrichment
// Optional stage: silently no-ops when HUBSPOT_ACCESS_TOKEN is unset.
// ===========================================================================

export async function runStageD(_today: number = todayMs()): Promise<{
  data: StageDData;
  durationMs: number;
  errors: string[];
}> {
  const started = Date.now();
  const errors: string[] = [];
  memSnap("D start");

  // Phase E-11 (G5) — Stage D atomicity. Two layers of failure handling:
  //
  //   1. If `fetchActiveHubspotCompanies` succeeds but returns zero rows OR
  //      throws, Stage D cannot meaningfully proceed. We throw — composeSnapshot
  //      reads yesterday's Stage D as a fallback (degraded_reason emitted).
  //
  //   2. Secondary fetches (deals/notes/calls/contacts) run in Promise.all
  //      under a single try/catch. Any one failure throws and aborts the
  //      stage — we do NOT publish a partial Stage D where some customers
  //      have HubSpot data and others don't. That inconsistency is the bug
  //      this guard prevents.
  //
  // When HUBSPOT_ACCESS_TOKEN isn't configured at all, the underlying helpers
  // return empty maps cleanly — that's the legacy "optional stage" behavior
  // and produces zero companies + no errors. Compose treats that as
  // "stage_d_hubspot_unavailable" via the degraded_reason path.

  // 1. Active customer companies from HubSpot
  let companiesMap: Map<string, HubspotCompanyRow>;
  try {
    companiesMap = await timed("companies", () => fetchActiveHubspotCompanies());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`hubspot:companies_fetch_failed:${msg.slice(0, 100)}`);
    // Re-throw so the cron route catches it and composeSnapshot falls back to
    // yesterday's Stage D instead of writing a broken partial.
    throw new Error(`Stage D aborted — HubSpot companies fetch failed: ${msg}`);
  }
  memSnap("D after companies");

  // Build canonical map keyed by place_id
  const companiesByPlaceId: Record<string, HubspotCompanyByPlaceId> = {};
  const hubspotCompanyIds: string[] = [];
  for (const [placeId, c] of companiesMap) {
    companiesByPlaceId[placeId] = {
      place_id: placeId,
      hubspot_company_id: c.id,
      name: c.name,
      icp_tier: c.icp_tier,
      lifecycle_stage: c.lifecycle_stage,
      business_category: c.business_category,
    };
    hubspotCompanyIds.push(c.id);
  }

  // 2. Deals per company — soft-fail (FIX-B). If deals don't land, ship
  // companies-only and emit a structured degraded_reason. Better than
  // wholesale-falling-back to yesterday's Stage D on a transient HubSpot
  // blip — at least customer identity / lifecycle stays today-fresh.
  let dealsMap: Map<string, DealsForCompany> = new Map();
  try {
    dealsMap = await timed("deals", () => fetchDealsForCompanies(hubspotCompanyIds));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`hubspot:deals_fetch_failed:${msg.slice(0, 100)}`);
    console.warn(`[stageD/deals] soft-fail: ${msg}`);
  }
  memSnap("D after deals");
  const dealsByHubspotCompanyId: Record<string, DealsForCompany> = {};
  for (const [cid, d] of dealsMap) dealsByHubspotCompanyId[cid] = d;

  // 3. Notes — FIX-A: read the cache by note_id BEFORE enrichment so we
  // don't re-pay the Haiku cost on every run. Without this, all ~900
  // notes re-enrich every night and Stage D blows past Vercel's 300s
  // function limit. Soft-fail under a 90s budget so a slow LLM doesn't
  // strand the rest of Stage D.
  let notesByHubspotCompanyId: Record<string, LastCallSummary> = {};
  let notesEnrichedNew = 0;
  let notesEnrichedCached = 0;
  try {
    const notesStarted = Date.now();

    // Phase 1 — discover latest note id per company (cheap, no LLM).
    const latestNotes = await timed("notes:discover", () =>
      fetchLatestNotePerCompany(hubspotCompanyIds),
    );
    const noteIds: string[] = [];
    for (const n of latestNotes.values()) noteIds.push(n.id);

    // Phase 2 — hydrate the enrichment cache by note_id. On a steady-
    // state book this is ~95%+ cache hit ratio, which is the whole
    // reason Stage D fits inside Vercel's 5-minute budget.
    const cached = await readNoteEnrichments(noteIds);

    // Phase 3 — enrich only the un-cached notes, under a wall-clock
    // budget. If the LLM is slow we'd rather ship partial enrichment
    // than abort the stage and serve yesterday's data.
    const NOTES_BUDGET_MS = 90_000;
    const discovered = await Promise.race([
      timed("notes:enrich", () =>
        fetchEnrichedNotesPerCompany(hubspotCompanyIds, cached),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`notes_budget_exceeded:${NOTES_BUDGET_MS}ms`)),
          NOTES_BUDGET_MS,
        ),
      ),
    ]);

    if (discovered.toCache.size > 0) {
      await writeNoteEnrichments(discovered.toCache as Map<string, CachedNoteEnrichment>);
    }
    notesByHubspotCompanyId = Object.fromEntries(discovered.perCompany);
    notesEnrichedNew = discovered.toCache.size;
    notesEnrichedCached = cached.size;
    console.log(
      `[stageD/notes] ${notesEnrichedCached} cache hits, ${notesEnrichedNew} new, ` +
        `${Date.now() - notesStarted}ms`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`hubspot:notes_fetch_failed:${msg.slice(0, 100)}`);
    console.warn(`[stageD/notes] soft-fail: ${msg}`);
    // Notes is intentionally soft — empty notes map, structured error in
    // degraded_reasons. Companies/deals/calls/contacts still land.
  }
  memSnap("D after notes");

  // 4 + 5. Calls + Contacts — soft-fail (FIX-B). Same reasoning as deals:
  // a transient HubSpot 5xx on calls shouldn't strand the entire dashboard
  // on yesterday's data. Each soft-fails independently with a structured
  // reason. composeSnapshot still surfaces the banner so AMs know.
  let callsMap: Map<string, CallsForCompany> = new Map();
  let contactsMap: Map<string, CompanyContact[]> = new Map();
  try {
    callsMap = await timed("calls", () => fetchCallsForCompanies(hubspotCompanyIds));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`hubspot:calls_fetch_failed:${msg.slice(0, 100)}`);
    console.warn(`[stageD/calls] soft-fail: ${msg}`);
  }
  try {
    contactsMap = await timed("contacts", () => fetchContactsForCompanies(hubspotCompanyIds));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`hubspot:contacts_fetch_failed:${msg.slice(0, 100)}`);
    console.warn(`[stageD/contacts] soft-fail: ${msg}`);
  }
  memSnap("D after calls + contacts");
  const callsByHubspotCompanyId: Record<string, CallsForCompany> = {};
  for (const [cid, c] of callsMap) callsByHubspotCompanyId[cid] = c;
  const contactsByHubspotCompanyId: Record<string, CompanyContact[]> = {};
  for (const [cid, cs] of contactsMap) contactsByHubspotCompanyId[cid] = cs;

  const data: StageDData = {
    companiesByPlaceId,
    dealsByHubspotCompanyId,
    notesByHubspotCompanyId,
    callsByHubspotCompanyId,
    contactsByHubspotCompanyId,
    diagnostics: {
      totalCompanies: Object.keys(companiesByPlaceId).length,
      companiesWithDeals: Object.keys(dealsByHubspotCompanyId).length,
      companiesWithRecentNotes: Object.keys(notesByHubspotCompanyId).length,
      companiesWithCalls: Object.keys(callsByHubspotCompanyId).length,
      companiesWithContacts: Object.keys(contactsByHubspotCompanyId).length,
      notesEnrichedNew,
      notesEnrichedCached,
    },
  };
  console.log(
    `[stageD] summary: ${Object.keys(companiesByPlaceId).length} companies, ` +
      `deals=${Object.keys(dealsByHubspotCompanyId).length}, ` +
      `notes=${Object.keys(notesByHubspotCompanyId).length}, ` +
      `calls=${Object.keys(callsByHubspotCompanyId).length}, ` +
      `contacts=${Object.keys(contactsByHubspotCompanyId).length}`,
  );
  return { data, durationMs: Date.now() - started, errors };
}

// ===========================================================================
// COMPOSE — read all 3 stage states, score, build snapshot, write
// ===========================================================================

/**
 * Compose final snapshot from the 3 stage states in Postgres.
 * Throws if any stage is missing. Caller is expected to handle this and
 * report the missing stage clearly.
 */
export async function composeSnapshot(
  snapshotDate: string = todaySnapshotDate(),
  options: { autoRunMissingStages?: boolean } = { autoRunMissingStages: true },
): Promise<SnapshotV2> {
  const started = Date.now();
  const errors: string[] = [];
  memSnap("compose start");

  // -------------------------------------------------------------------------
  // 1. Load all 3 stage states
  // -------------------------------------------------------------------------
  let { a, b, c, d, missing, staleStages } = await readAllPipelineStages(snapshotDate);

  if (missing.length && options.autoRunMissingStages !== false) {
    console.log(`[compose] auto-running missing stages: ${missing.join(", ")}`);
    for (const stage of missing) {
      try {
        if (stage === "A") await runStageAAndStore(snapshotDate);
        if (stage === "B") await runStageBAndStore(snapshotDate);
        if (stage === "C") await runStageCAndStore(snapshotDate);
        if (stage === "D") await runStageDAndStore(snapshotDate);
        errors.push(`auto-ran stage ${stage}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`auto-run stage ${stage} failed: ${msg}`);
      }
    }
    ({ a, b, c, d, missing, staleStages } = await readAllPipelineStages(snapshotDate));
  }

  if (missing.length) {
    throw new Error(
      `[compose] missing stage(s): ${missing.join(", ")} for ${snapshotDate}. ` +
        `Run /api/cron/refresh/stage-${missing[0].toLowerCase()} first.`,
    );
  }
  if (staleStages.length) {
    errors.push(`stale stages (>6h old): ${staleStages.join(", ")}`);
  }
  memSnap("compose after reads");

  const stageA = a!.data as StageAData;
  const stageB = b!.data as StageBData;
  const stageC = c!.data as StageCData;
  // Phase E-11 (G5) — Stage D fallback. If today's Stage D is missing (cron
  // failed atomically or HubSpot token unset), look back up to 3 days for the
  // most recent successful Stage D so the dashboard isn't blank for HubSpot
  // fields. Emit a structured degraded_reason so the UI banner shows what
  // happened — the AM should know yesterday's HubSpot data is being shown.
  let stageD = (d?.data as StageDData | undefined) ?? null;
  if (!stageD) {
    for (let daysBack = 1; daysBack <= 3; daysBack++) {
      const dt = new Date(snapshotDate + "T00:00:00Z");
      dt.setUTCDate(dt.getUTCDate() - daysBack);
      const ymd = dt.toISOString().slice(0, 10);
      const fallback = await readPipelineStage<StageDData>("D", ymd);
      if (fallback) {
        stageD = fallback.data;
        errors.push(`stage_d_used_yesterday_fallback:${ymd}_${daysBack}d`);
        console.warn(`[compose] using Stage D fallback from ${ymd} (${daysBack}d ago)`);
        break;
      }
    }
  }
  const today = stageA.todayMs;

  // -------------------------------------------------------------------------
  // Phase 31.v2 — Single Metabase CSV fetch for tickets, BEFORE the scoring
  // loop. Soft-fails to an empty Map on any error so the entire compose stays
  // resilient. Aggregates are derived per-customer inside the loop below.
  // -------------------------------------------------------------------------
  const ticketsResult = await fetchTicketsFromMetabase();
  let ticketsCustomersMatched = 0;
  let ticketsCustomersWithStale = 0;

  // Pre-build HubSpot lookups if Stage D landed
  const hubspotByPlaceId: Map<string, HubspotCompanyByPlaceId> = new Map();
  const hubspotByNormalizedName: Map<string, HubspotCompanyByPlaceId> = new Map();
  if (stageD) {
    const { normalizeName } = await import("./hubspot-companies");
    for (const c of Object.values(stageD.companiesByPlaceId)) {
      if (c.place_id) hubspotByPlaceId.set(c.place_id, c);
      hubspotByNormalizedName.set(normalizeName(c.name), c);
    }
    console.log(
      `[compose] stageD shape: companies=${Object.keys(stageD?.companiesByPlaceId ?? {}).length}, ` +
        `deals=${Object.keys(stageD?.dealsByHubspotCompanyId ?? {}).length}, ` +
        `notes=${Object.keys(stageD?.notesByHubspotCompanyId ?? {}).length}, ` +
        `calls=${Object.keys(stageD?.callsByHubspotCompanyId ?? {}).length}, ` +
        `contacts=${Object.keys(stageD?.contactsByHubspotCompanyId ?? {}).length}`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. Score every active entity by combining the 3 stages' data
  // -------------------------------------------------------------------------
  const scored: ScoredCustomerV2[] = [];
  let mixpanelCoverage = 0;
  let matchedByPlaceId = 0;
  let matchedByBizname = 0;
  let hubspotUnmatched = 0;

  // Cutoff used for closed_last_30d_count below.
  const cutoff30d = today - 30 * 86400 * 1000;

  // Phase E-19.3 — pre-fetch comms_perspective rows for ALL active entities
  // up front so scoreCustomer can apply sentiment/substance adjustments to
  // the composite. Was previously hydrated AFTER scoring (read-only into the
  // snapshot blob for the UI sentiment chip). Now it influences tier too.
  //
  // READ-ONLY: composeSnapshot never triggers Haiku (would be ~927 calls per
  // refresh). The on-demand /api/customer/perspective endpoint lazily
  // populates rows when an AM opens a customer. Missing rows → null → no
  // perspective adjustment applied.
  type PerspectiveRowMap = Awaited<ReturnType<
    typeof import("./comms-perspective-store").readPerspectivesForEntities
  >>;
  let perspectivesByEntity: PerspectiveRowMap = new Map();
  try {
    const { readPerspectivesForEntities } = await import(
      "./comms-perspective-store"
    );
    perspectivesByEntity = await readPerspectivesForEntities(stageA.activeEntityIds);
    console.log(
      `[E-19.3] perspectives pre-loaded: ${perspectivesByEntity.size}/${stageA.activeEntityIds.length}`,
    );
  } catch (e) {
    console.warn(
      "[E-19.3] perspective pre-load failed (scoring will skip sentiment adjustment):",
      e instanceof Error ? e.message : String(e),
    );
  }

  for (const entityId of stageA.activeEntityIds) {
    const meta = stageA.entityMeta[entityId];
    const bs = stageA.baseSheetByEntityId[entityId];
    const billing = stageA.billingMetrics[entityId] || null;

    // Comms — if not in B's map (zero-comms entity), build empty metrics
    const cMetrics: CustomerMetrics =
      stageB.commsMetricsByEntity[entityId] || computeMetrics([], today);
    const v1Signals = scoreCustomer(cMetrics);

    // Usage
    const usage = stageC.usageMetricsByEntity[entityId] || null;
    if (usage) mixpanelCoverage++;
    const usageScore = scoreUsage(usage);

    // Billing
    const billingScore = scoreBilling(billing);

    // Performance + tickets flags. The flag itself is still derived from the
    // BaseSheet counts so the existing scoring math doesn't move; Phase 31.v2
    // merges the Metabase records + aggregates onto the same object below.
    const perf = stageC.performanceMetricsByEntity[entityId] || null;
    const ticketsFlag = computeTicketsFlag(
      entityId,
      Number(bs?.open_tickets_30d || 0),
      Number(bs?.unresolved_issues_last_30_days || 0),
    );

    // ---------------------------------------------------------------------
    // Phase 31.v2 — Per-customer tickets enrichment from Metabase records.
    // Preserves the existing BaseSheet-derived `open_tickets_30d` and
    // `unresolved_issues_last_30_days` (legacy counters) and adds the new
    // per-record + aggregate fields. If no Metabase records exist for this
    // entity, all new aggregates default to zero / empty.
    // ---------------------------------------------------------------------
    const entityTickets: UnifiedTicket[] = ticketsResult.byEntityId.get(entityId) ?? [];
    if (entityTickets.length > 0) ticketsCustomersMatched += 1;
    let openCount = 0;
    let openStaleCount = 0;
    let closedLast30dCount = 0;
    let oldestOpenAgeDays: number | null = null;
    const byCategory: Record<string, number> = {};
    for (const t of entityTickets) {
      byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
      if (t.is_closed) {
        const closedIso = t.completed_at || t.canceled_at;
        if (closedIso) {
          const closedMs = Date.parse(closedIso);
          if (Number.isFinite(closedMs) && closedMs >= cutoff30d) {
            closedLast30dCount += 1;
          }
        }
      } else {
        openCount += 1;
        if (t.is_stale) openStaleCount += 1;
        if (oldestOpenAgeDays === null || t.age_days > oldestOpenAgeDays) {
          oldestOpenAgeDays = t.age_days;
        }
      }
    }
    if (openStaleCount > 0) ticketsCustomersWithStale += 1;
    const tickets: TicketsMetrics = {
      ...ticketsFlag,
      records: entityTickets.slice(0, TICKETS_MAX_RECORDS_PER_CUSTOMER),
      open_count: openCount,
      open_stale_count: openStaleCount,
      closed_last_30d_count: closedLast30dCount,
      by_category: byCategory,
      oldest_open_age_days: oldestOpenAgeDays,
    };

    // Detect pre-launch: Chargebee sub status is "future" OR activated_at
    // is null/in-the-future. These customers haven't started using the
    // product yet, so they shouldn't be scored as churning.
    const nowMs = stageA.todayMs;
    const activatedMs = meta?.activated_at ? Date.parse(meta.activated_at) : NaN;
    const preLaunch =
      meta?.sub_status === "future" ||
      !meta?.activated_at ||
      (Number.isFinite(activatedMs) && activatedMs > nowMs);

    // Compose hybrid signals
    const signalsV2 = composeHybridSignals({
      commsSignals: v1Signals,
      usageScore,
      billingScore,
      billing,
      performance: perf,
      tickets,
      commsMetrics: cMetrics,
      mixpanelHasData: usage !== null,
      preLaunch,
      // Phase E-19.3 — sentiment + substance adjustment from Haiku cache.
      perspective: perspectivesByEntity.get(entityId) ?? null,
    });

    // Phase 33.scope — recently churned customers are already gone;
    // don't let them clog the at-risk stack. Override stoplight to GREEN
    // (neutral) so existing math is preserved while UI uses lifecycle_state.
    {
      const _cidNeutral = meta?.customer_id || "";
      const _churn = stageA.recentlyChurnedByCustomer?.[_cidNeutral];
      const _hasLive = !!meta?.subscription_id;
      if (!_hasLive && _churn) {
        (signalsV2 as any).stoplight = "GREEN";
        (signalsV2 as any).tier = "HEALTHY";
      }
    }
    // Pod from AM
    const amName = bs?.am_name || "";
    const pod = POD_MAP[amName] || "";

    // HubSpot join (Phase 14A) — place_id first, bizname fallback.
    let hubspotJoin: ScoredCustomerV2["hubspot"] = null;
    if (stageD) {
      const { normalizeName } = await import("./hubspot-companies");
      let hsCo: HubspotCompanyByPlaceId | undefined;
      let matchedVia: "place_id" | "bizname" | null = null;
      const placeId = meta?.place_id || "";
      if (placeId) {
        hsCo = hubspotByPlaceId.get(placeId);
        if (hsCo) matchedVia = "place_id";
      }
      if (!hsCo) {
        // Phase 33.scope-fix7 — same fallback chain as scored.push.
        const lookupName = (bs?.bizname || meta?.entity_name_from_chargebee || meta?.company_from_chargebee || "").trim();
        if (lookupName) {
          hsCo = hubspotByNormalizedName.get(normalizeName(lookupName));
          if (hsCo) matchedVia = "bizname";
        }
      }
      if (hsCo) {
        if (matchedVia === "place_id") matchedByPlaceId++;
        else if (matchedVia === "bizname") matchedByBizname++;
        const deals = stageD?.dealsByHubspotCompanyId?.[hsCo.hubspot_company_id];
        const note = stageD?.notesByHubspotCompanyId?.[hsCo.hubspot_company_id];
        const lifecycleDrift =
          !!hsCo.lifecycle_stage && hsCo.lifecycle_stage.toLowerCase() !== "customer";

        const hubspotCalls =
          stageD?.callsByHubspotCompanyId?.[hsCo.hubspot_company_id]?.call_count_30d ?? 0;
        const metabaseCalls =
          stageB.channelCounts30dByEntity[entityId]?.phone ?? 0;
        const driftDelta = hubspotCalls - metabaseCalls;
        const commsDrift =
          Math.abs(driftDelta) >= 3
            ? {
                hubspot_calls_30d: hubspotCalls,
                metabase_calls_30d: metabaseCalls,
                delta: driftDelta,
              }
            : null;

        const contacts =
          stageD?.contactsByHubspotCompanyId?.[hsCo.hubspot_company_id] ?? [];

        hubspotJoin = {
          hubspot_company_id: hsCo.hubspot_company_id,
          icp_tier: hsCo.icp_tier,
          lifecycle_drift: lifecycleDrift,
          open_deal_count: deals?.open_deal_count ?? 0,
          open_deal_stages: deals?.open_deal_stages ?? [],
          total_open_amount: deals?.total_open_amount ?? 0,
          last_call: note
            ? {
                note_id: note.note_id,
                date: note.date,
                sentiment: note.sentiment,
                topics: note.topics,
                action_items: note.action_items,
                fireflies_url: note.fireflies_url,
              }
            : null,
          comms_drift: commsDrift,
          contacts,
        };
      } else {
        hubspotUnmatched++;
      }
    }

    // Phase 33.scope — derive lifecycle_state for this customer.
    const _cidForLifecycle = meta?.customer_id || "";
    const _recentlyChurned = stageA.recentlyChurnedByCustomer?.[_cidForLifecycle] || null;
    // Phase 33.scope-fix1 — pure-churn customers have subscription_id set
    // (subsByCustomer stores any sub if no live sub overrode it), so we must
    // also require sub_status !== "cancelled" to call them a live sub.
    const _subStatus = meta?.sub_status || "";
    const _hasLiveSub = !!meta?.subscription_id && _subStatus !== "cancelled";
    const _activatedIso = meta?.activated_at || null;
    const _activatedMs = _activatedIso ? Date.parse(_activatedIso) : NaN;
    const _thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const _isNewlyOnboarded = _hasLiveSub && Number.isFinite(_activatedMs) && (stageA.todayMs - _activatedMs) <= _thirtyDaysMs && !_recentlyChurned;
    const _isResurrected = _hasLiveSub && !!_recentlyChurned;
    const _isRecentlyChurned = !_hasLiveSub && !!_recentlyChurned;
    let _lifecycle_state: "active" | "recently_churned" | "newly_onboarded" | "resurrected" = "active";
    if (_isRecentlyChurned) _lifecycle_state = "recently_churned";
    else if (_isResurrected) _lifecycle_state = "resurrected";
    else if (_isNewlyOnboarded) _lifecycle_state = "newly_onboarded";
    const _churnedOn = _recentlyChurned?.cancelled_at || null;
    const _onboardedOn = _activatedIso;

    // Phase E-11 — per-customer signal freshness. Independent of lifecycle_state
    // because a "resurrected" customer is also "fresh" in signal terms — they may
    // have new entity_id w/o history yet.
    //   <48h since activation  → "fresh"   (signals will be empty by design)
    //   48h–7d                  → "warming" (some signals starting to land)
    //   >7d                     → "ready"   (signals are trustworthy)
    // Recently_churned customers stay "ready" — their signals reflect their last
    // active period and are not "fresh" in any meaningful sense.
    let _signal_state: "fresh" | "warming" | "ready" | "stale_signals" = "ready";
    if (_hasLiveSub && Number.isFinite(_activatedMs)) {
      const ageMs = stageA.todayMs - _activatedMs;
      const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      if (ageMs <= twoDaysMs) _signal_state = "fresh";
      else if (ageMs <= sevenDaysMs) _signal_state = "warming";
    }
    scored.push({
      customer_id: meta?.customer_id || "",
      entity_id: entityId,
      subscription_id: meta?.subscription_id || "",
      // Phase 33.scope-fix7 — prefer entity-specific Chargebee name over customer-level company.
      company: bs?.bizname || meta?.entity_name_from_chargebee || meta?.company_from_chargebee || "",
      email: bs?.app_email || meta?.email || "",
      phone: bs?.phone_number || meta?.phone || "",
      am_name: amName,
      ae_name: bs?.ae_name || "",
      sp_name: bs?.sp_name || "",
      cb_status: meta?.sub_status || "",
      auto_collection: meta?.auto_collection || null,
      plan_amount: (meta?.plan_amount_cents || 0) / 100,
      mrr_basesheet: bs?.total_monthly_revenue || "",
      zoca_status: bs?.chrone_zoca_status || "",
      churn_potential_flag: bs?.churn_potential_flag || "",
      activated_at: meta?.activated_at || null,
      ob_date: bs?.ob_date || "",
      match_source: bs ? "customer_id" : "unmatched",
      in_chrone: ((bs?.chrone_zoca_status || "").toUpperCase() === "ZOCA"),
      metrics: cMetrics,
      signals: v1Signals,
      pod,
      usage,
      billing,
      performance: perf,
      tickets,
      signals_v2: signalsV2,
      hubspot: hubspotJoin,
      lifecycle_state: _lifecycle_state,
      churned_on: _churnedOn,
      onboarded_on: _onboardedOn,
      signal_state: _signal_state,
    });
  }

  memSnap("compose after score");
  console.log(
    `[phase31v2] tickets refresh: ${ticketsResult.totalRows} rows, ` +
      `${ticketsCustomersMatched} customers matched, ` +
      `${ticketsResult.parseErrors} rows skipped (no entity_id or bad row), ` +
      `${ticketsCustomersWithStale} customers with stale tickets >7d`,
  );
  if (stageD) {
    console.log(
      `[compose] hubspot join: ${matchedByPlaceId} via place_id, ${matchedByBizname} via bizname, ${hubspotUnmatched} unmatched`,
    );
  }

  // -------------------------------------------------------------------------
  // Phase E-18 — hydrate the slim comms_perspective shape into each scored
  // customer for the UI sentiment chip + Haiku-summary panel. Reuses the
  // perspectivesByEntity Map populated above in the scoring loop, so no
  // second DB round-trip.
  // -------------------------------------------------------------------------
  {
    let hits = 0;
    for (const c of scored) {
      const p = perspectivesByEntity.get(c.entity_id);
      c.comms_perspective = p
        ? {
            sentiment: p.sentiment,
            topics: p.topics,
            substance_score: p.substance_score,
            initiator_pattern: p.initiator_pattern,
            response_latency_hours: p.response_latency_hours,
          }
        : null;
      if (p) hits += 1;
    }
    console.log(
      `[E-18] comms perspective hydration: ${hits}/${scored.length} cache hits`,
    );
  }

  // Sort by composite desc, then comms volume desc
  scored.sort((a, b) => {
    if (b.signals_v2.composite !== a.signals_v2.composite) return b.signals_v2.composite - a.signals_v2.composite;
    return b.metrics.total_90d - a.metrics.total_90d;
  });

  // -------------------------------------------------------------------------
  // 3. Aggregates (tier counts, breakdowns, etc.)
  // -------------------------------------------------------------------------
  const tierCounts: Record<Tier, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, HEALTHY: 0 };
  const stoplightCounts: Record<Stoplight, number> = { RED: 0, YELLOW: 0, GREEN: 0 };
  for (const c of scored) {
    // Phase 33.scope optionB — exclude recently_churned from tier/stoplight totals.
    if (c.lifecycle_state === "recently_churned") continue;
    tierCounts[c.signals_v2.tier]++;
    stoplightCounts[c.signals_v2.stoplight]++;
  }

  const signalCountsV2 = {
    we_silent_any: scored.filter((r) => r.signals_v2.sig_we_silent >= 30).length,
    client_silent_any: scored.filter((r) => r.signals_v2.sig_client_silent >= 30).length,
    response_drop_any: scored.filter((r) => r.signals_v2.sig_response_drop >= 30).length,
    volume_collapse_any: scored.filter((r) => r.signals_v2.sig_volume_collapse >= 30).length,
    usage_dormant: scored.filter((r) => r.signals_v2.sig_usage >= 65).length,
    billing_crisis: scored.filter((r) => r.signals_v2.sig_billing >= 50).length,
    performance_flagged: scored.filter((r) => r.signals_v2.flag_performance).length,
    tickets_flagged: scored.filter((r) => r.signals_v2.flag_tickets).length,
  };
  const signalCounts = {
    we_silent_any: signalCountsV2.we_silent_any,
    client_silent_any: signalCountsV2.client_silent_any,
    response_drop_any: signalCountsV2.response_drop_any,
    volume_collapse_any: signalCountsV2.volume_collapse_any,
  };

  // AM breakdown
  const amMap = new Map<string, { high: number; total: number }>();
  const amBreakdownMap = new Map<string, AmTierRow>();
  for (const c of scored) {
    // Phase 33.scope optionB — exclude recently_churned from AM breakdown.
    if (c.lifecycle_state === "recently_churned") continue;
    const am = c.am_name || "(unassigned)";
    const cur = amMap.get(am) || { high: 0, total: 0 };
    cur.total++;
    if (c.signals_v2.tier === "HIGH") cur.high++;
    amMap.set(am, cur);
    const row = amBreakdownMap.get(am) || { am, HIGH: 0, MEDIUM: 0, LOW: 0, HEALTHY: 0, total: 0 };
    row[c.signals_v2.tier]++;
    row.total++;
    amBreakdownMap.set(am, row);
  }
  const amExposure = Array.from(amMap, ([am, v]) => ({ am, ...v }))
    .sort((a, b) => (b.high - a.high) || (b.total - a.total));
  const amTierBreakdown = Array.from(amBreakdownMap.values())
    .sort((a, b) => (b.HIGH - a.HIGH) || (b.total - a.total));

  // Pod breakdown
  const podMap = new Map<string, PodTierRow>();
  for (const c of scored) {
    // Phase 33.scope optionB — exclude recently_churned from pod breakdown.
    if (c.lifecycle_state === "recently_churned") continue;
    const pod = c.pod || "(unassigned)";
    const row = podMap.get(pod) || { pod, HIGH: 0, MEDIUM: 0, LOW: 0, HEALTHY: 0, total: 0, ams: [] };
    row[c.signals_v2.tier]++;
    row.total++;
    if (c.am_name && !row.ams.includes(c.am_name)) row.ams.push(c.am_name);
    podMap.set(pod, row);
  }
  const podBreakdown = Array.from(podMap.values())
    .sort((a, b) => (b.HIGH - a.HIGH) || (b.total - a.total));

  // Score distribution
  const scoreDistribution: number[] = new Array(10).fill(0);
  for (const c of scored) {
    const s = Math.max(0, Math.min(99, c.signals_v2.composite));
    scoreDistribution[Math.floor(s / 10)]++;
  }

  // Book-wide numeric stats
  const t30 = scored.map((c) => c.metrics.total_30d).sort((a, b) => a - b);
  const t90 = scored.map((c) => c.metrics.total_90d).sort((a, b) => a - b);
  const med = (arr: number[]) => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);
  const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const totalComms90d = scored.reduce((a, c) => a + c.metrics.total_90d, 0);

  const matchBreakdown = {
    byCustomerId: scored.filter((c) => c.match_source === "customer_id").length,
    byBizName: scored.filter((c) => c.match_source === "bizname").length,
    unmatched: scored.filter((c) => c.match_source === "unmatched").length,
    notInChrone: scored.filter((c) => !c.in_chrone).length,
  };

  // Phase E-11 — derive per-stage freshness from the pipeline_state reads and
  // synthesize structured degraded_reasons. Used by the V2Dashboard banner.
  const _stageFreshness = {
    A: a?.generatedAt ?? null,
    B: b?.generatedAt ?? null,
    C: c?.generatedAt ?? null,
    D: d?.generatedAt ?? null,
  };
  const _twentyFiveHoursMs = 25 * 60 * 60 * 1000;
  const _nowMs = Date.now();
  const _degradedReasons: string[] = [];
  // Treat A/B/C as required, D as optional. Any required stage >25h stale is a
  // user-visible degraded state. Stage D 25h+ stale only matters if it ran at
  // all — if it never ran, that's a separate "hubspot_unavailable" reason.
  for (const stage of ["A", "B", "C"] as const) {
    const iso = _stageFreshness[stage];
    if (!iso) continue;
    const age = _nowMs - Date.parse(iso);
    if (age > _twentyFiveHoursMs) _degradedReasons.push(`stage_${stage.toLowerCase()}_stale_${Math.floor(age / 3600_000)}h`);
  }
  if (!stageD) _degradedReasons.push("stage_d_hubspot_unavailable");
  else if (_stageFreshness.D) {
    const ageD = _nowMs - Date.parse(_stageFreshness.D);
    if (ageD > _twentyFiveHoursMs) _degradedReasons.push(`stage_d_stale_${Math.floor(ageD / 3600_000)}h`);
  }
  // Surface any structured errors from upstream stages (Stage A integrity
  // assertions push their findings into the errors[] array below).
  for (const e of errors) {
    if (typeof e === "string" && (e.startsWith("integrity:") || e.startsWith("stage_") || e.startsWith("hubspot:"))) {
      _degradedReasons.push(e);
    }
  }

  const health: DataHealth = {
    totalSubsFetched: stageA.stats.totalSubs,
    customersWithEntityId: scored.filter((c) => c.entity_id).length,
    customersWithAnyComms90d: scored.filter((c) => c.metrics.total_90d > 0).length,
    customersWithMixpanelData: mixpanelCoverage,
    customersWithBillingIssues: scored.filter((c) => c.billing && c.billing.unpaid_invoice_count > 0).length,
    customersWithPerformanceFlag: signalCountsV2.performance_flagged,
    customersWithTicketsFlag: signalCountsV2.tickets_flagged,
    matchBreakdown,
    perSourceEventCount: stageB.perSourceEventCount as DataHealth["perSourceEventCount"],
    perSourceRawRows: stageB.commsStats.rawRows as DataHealth["perSourceRawRows"],
    perDirectionCount: stageB.perDirectionCount,
    duplicateEventsRemoved: stageB.commsStats.totalDuplicatesRemoved,
    baseSheetRowCount: stageA.stats.baseSheetRowCount,
    mixpanelRowCount: stageC.diagnostics.mixpanelRowCount,
    performanceRowCounts: stageC.diagnostics.performanceRowCounts,
    chargebeeInvoiceCount: stageA.stats.totalInvoices,
    chargebeeTransactionCount: stageA.stats.totalTransactions,
    excludedEntities: stageA.stats.excludedCount,
    multiEntityExpansion: stageA.stats.multiEntityExpansion,
    fetchErrors: errors,
    refreshDurationMs: Date.now() - started,
    signal_freshness_per_stage: _stageFreshness,
    degraded_reasons: _degradedReasons.length ? _degradedReasons : undefined,
  };

  const snapshot: SnapshotV2 = {
    version: "v2",
    generatedAt: new Date().toISOString(),
    todayIso: stageA.todayIso,
    totalActive: scored.length,
    tierCounts,
    stoplightCounts,
    signalCounts,
    signalCountsV2,
    channelCounts: stageB.channelCounts,
    amExposure,
    amTierBreakdown,
    podBreakdown,
    scoreDistribution,
    customers: scored,
    activeEntityIds: stageA.activeEntityIds,
    mixpanelCoverage: {
      activeWithMixpanel: mixpanelCoverage,
      activeWithoutMixpanel: scored.length - mixpanelCoverage,
    },
    stats: {
      total_comms_90d: totalComms90d,
      median_30d: med(t30),
      mean_30d: Number(mean(t30).toFixed(2)),
      median_90d: med(t90),
      mean_90d: Number(mean(t90).toFixed(2)),
      fetch_duration_ms: Date.now() - started,
    },
    health,
    errors: errors.length ? errors : undefined,
  };

  for (const t of TIER_ORDER) {
    if (snapshot.tierCounts[t] == null) snapshot.tierCounts[t] = 0;
  }

  // -------------------------------------------------------------------------
  // 2.4  LLM narrative enrichment for RED customers (Phase 11)
  // -------------------------------------------------------------------------
  try {
    const result = await enrichRedNarratives(snapshot);
    console.log(
      `[compose] narrative enrichment: enriched=${result.enriched} skipped=${result.skipped} took ${result.durationMs}ms`,
    );
    if (result.enriched > 0) errors.push(`narrative enrichment ran on ${result.enriched} customers`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[compose] narrative enrichment failed:", msg);
    errors.push(`narrative enrichment: ${msg}`);
  }

  // -------------------------------------------------------------------------
  // 2.5  Trajectory backfill
  // -------------------------------------------------------------------------
  try {
    const sevenDaysAgo = new Date(snapshotDate + "T00:00:00Z");
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
    const ymd7 = sevenDaysAgo.toISOString().slice(0, 10);
    let prevSnap = await readSnapshotByDate(ymd7);
    let prevWindowDays = 7;
    if (!prevSnap) {
      const yesterday = new Date(snapshotDate + "T00:00:00Z");
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      prevSnap = await readSnapshotByDate(yesterday.toISOString().slice(0, 10));
      prevWindowDays = 1;
    }
    if (prevSnap) {
      const prevByEntity = new Map<string, number>();
      for (const c of prevSnap.customers || []) {
        if (c.entity_id && typeof c.signals_v2?.composite === "number") {
          prevByEntity.set(c.entity_id, c.signals_v2.composite);
        }
      }
      const STABLE_DELTA = 5;
      let patched = 0;
      for (const c of snapshot.customers) {
        const prev = prevByEntity.get(c.entity_id);
        if (prev === undefined) continue;
        c.signals_v2.composite_7d_ago = prev;
        const delta = c.signals_v2.composite - prev;
        if (Math.abs(delta) < STABLE_DELTA) c.signals_v2.trajectory_7d = "stable";
        else if (delta > 0) c.signals_v2.trajectory_7d = "improving";
        else c.signals_v2.trajectory_7d = "worsening";
        patched += 1;
      }
      console.log(
        `[compose] trajectory backfilled ${patched}/${snapshot.customers.length} via ${prevWindowDays}d-ago snapshot`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[compose] trajectory backfill failed:", msg);
    errors.push(`trajectory backfill: ${msg}`);
  }

  // -------------------------------------------------------------------------
  // 2.6  Phase 13.1: scope meta + status-guard assertion.
  // -------------------------------------------------------------------------
  {
    const allowedStatuses = new Set(["active", "non_renewing", "in_trial", "future"]);
    // Phase 33.scope-fix4 — recently_churned customers intentionally have
    // cb_status="cancelled" (30-day retention window). Allow them through
    // the guard; still block any other unexpected status.
    const invalid = scored.filter((c) => !allowedStatuses.has(c.cb_status) && c.lifecycle_state !== "recently_churned");
    if (invalid.length > 0) {
      const examples = invalid
        .slice(0, 3)
        .map((c) => `${c.company}=${c.cb_status}`)
        .join(", ");
      throw new Error(
        `Phase 13.1 scope guard: ${invalid.length} customers in snapshot have subscription_status outside ` +
          `the active-sub universe. Examples: ${examples}. Refusing to write snapshot to prevent dashboard drift.`,
      );
    }
    const byCid = new Map<string, number>();
    for (const c of scored) {
      const cid = c.customer_id;
      if (!cid) continue;
      byCid.set(cid, (byCid.get(cid) ?? 0) + 1);
    }
    let multiLocCount = 0;
    for (const n of byCid.values()) if (n > 1) multiLocCount += 1;
    snapshot.scope = {
      universe: "chargebee_active_sub",
      statuses: ["active", "non_renewing", "in_trial", "future"],
      customer_count: scored.length,
      customer_id_count: byCid.size,
      multi_location_count: multiLocCount,
      recently_churned_count: scored.filter((c) => c.lifecycle_state === "recently_churned").length,
      newly_onboarded_count: scored.filter((c) => c.lifecycle_state === "newly_onboarded").length,
      resurrected_count: scored.filter((c) => c.lifecycle_state === "resurrected").length,
    };
  }

  memSnap("compose before write");
  if (pgConfigured()) {
    try {

      // Phase G2 — enrich snapshot with metabase health tier before persisting.

      // Defensive: any downstream consumer that reads dashboard_snapshots directly

      // (vs. through /api/v2/snapshot's read-time enrichment) gets the tier for free.

      try {

        const _hcMap = await getHealthCardMap();

        if (_hcMap.size > 0) {

          for (const _c of (snapshot as any)?.customers || [] as any[]) {

            const _eid = (_c?.entity_id || "").toLowerCase();

            const _row: any = _hcMap.get(_eid);

            if (_row) {

              (_c as any).metabase_health = _row;

            }

          }

        }

      } catch (_e) {

        console.warn("[compose] health-card enrichment skipped:", _e instanceof Error ? _e.message : String(_e));

      }

      await writeSnapshotV2(snapshot);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[compose] Postgres write failed:", msg);
      errors.push(`Postgres write: ${msg}`);
    }
    try {
      // Phase 33.scope-optionZ — exclude recently_churned from the
      // historical trend. They're forced GREEN by compose and would
      // pad the trend's healthy count over time as the universe shifts.
      const trendRows = snapshot.customers
        .filter((c) => c.lifecycle_state !== "recently_churned")
        .map((c) => ({
        entity_id: c.entity_id,
        am_name: c.am_name || "",
        pod: c.pod || "",
        composite: c.signals_v2.composite,
        stoplight: c.signals_v2.stoplight,
        plan_amount: c.plan_amount || 0,
        perf_flagged: !!c.performance?.flag,
      }));
      const written = await writeCustomerTrendRows(snapshotDate, trendRows);
      console.log(`[compose] customer_trends rows written: ${written}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[compose] customer_trends write failed:", msg);
      errors.push(`customer_trends write: ${msg}`);
    }
  }
  memSnap("compose end");

  console.log(
    "[compose] active:", scored.length,
    "tiers:", tierCounts,
    "stoplight:", stoplightCounts,
    "duration:", health.refreshDurationMs + "ms",
  );
  return snapshot;
}

// ===========================================================================
// Helpers used by stage API routes
// ===========================================================================

export async function runStageAAndStore(snapshotDate?: string): Promise<{
  durationMs: number;
  errors: string[];
  rowCount: number;
  /** Phase E-11 (G3) — entity_ids new in this run vs. yesterday's stage A. */
  newEntityIds: string[];
}> {
  const date = snapshotDate ?? todaySnapshotDate();
  const { data, durationMs, errors } = await runStageA();
  await writePipelineStage("A", date, data, {
    durationMs,
    errors,
    rowCount: data.activeEntityIds.length,
  });

  // -------------------------------------------------------------------------
  // Phase E-11 (G3) — Targeted refresh on new-customer detection.
  // Diff today's active universe against yesterday's. If there are entity_ids
  // we didn't see before, fire Stage B/C/D so their signals don't sit empty
  // for ~24 hours. We return the diff so the route handler can wrap the chain
  // in waitUntil() and return promptly — see app/(customer)/api/cron/refresh/stage-a.
  // -------------------------------------------------------------------------
  let newEntityIds: string[] = [];
  try {
    const yesterdayDate = new Date(date + "T00:00:00Z");
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const ymd = yesterdayDate.toISOString().slice(0, 10);
    const yesterday = await readPipelineStage<StageAData>("A", ymd);
    if (yesterday) {
      const yesterdaySet = new Set(yesterday.data.activeEntityIds);
      newEntityIds = data.activeEntityIds.filter((eid) => !yesterdaySet.has(eid));
      if (newEntityIds.length > 0) {
        console.log(
          `[stage-a G3] detected ${newEntityIds.length} new entity_id(s) vs. ${ymd}: ${newEntityIds.slice(0, 3).join(", ")}${newEntityIds.length > 3 ? "…" : ""}`,
        );
      }
    } else {
      // No yesterday snapshot — first run, can't diff. Skip targeted refresh.
      console.log(`[stage-a G3] no yesterday snapshot at ${ymd} — skipping diff`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[stage-a G3] diff against yesterday failed: ${msg}`);
  }

  return { durationMs, errors, rowCount: data.activeEntityIds.length, newEntityIds };
}

/**
 * Phase E-11 (G3) — Run Stage B/C/D in parallel after Stage A detected new
 * customers. Designed to be called from a `waitUntil()` so it doesn't block
 * the Stage A cron response. Each stage failure is logged but doesn't abort
 * the others — partial signal landing is better than none for fresh customers.
 *
 * Compose at :05 will pick up whatever stages succeeded.
 */
export async function runTargetedRefreshForNewCustomers(
  snapshotDate: string,
  newEntityIds: string[],
): Promise<void> {
  if (newEntityIds.length === 0) return;
  console.log(
    `[targeted-refresh] firing B/C/D for ${newEntityIds.length} new customer(s) on ${snapshotDate}`,
  );
  const started = Date.now();
  const results = await Promise.allSettled([
    runStageBAndStore(snapshotDate),
    runStageCAndStore(snapshotDate),
    runStageDAndStore(snapshotDate),
  ]);
  const summary = results.map((r, i) => {
    const stage = ["B", "C", "D"][i];
    if (r.status === "fulfilled") return `${stage}=ok(${r.value.durationMs}ms)`;
    return `${stage}=fail(${r.reason instanceof Error ? r.reason.message : String(r.reason)})`;
  });
  console.log(`[targeted-refresh] complete in ${Date.now() - started}ms: ${summary.join(", ")}`);
}

export async function runStageBAndStore(snapshotDate?: string): Promise<{
  durationMs: number;
  errors: string[];
  rowCount: number;
}> {
  const date = snapshotDate ?? todaySnapshotDate();
  const stageA = await readPipelineStage<StageAData>("A", date);
  const anchorToday = stageA?.data?.todayMs ?? todayMs();
  // Phase E-19 W2 cutover — runStageB now ingests via the V2 bulk-events
  // Metabase question and needs Stage A's active universe to know which
  // entities to query. composeSnapshot reads from stage='B' as before.
  const activeEntityIds = stageA?.data?.activeEntityIds ?? [];
  const { data, durationMs, errors } = await runStageB(anchorToday, activeEntityIds);
  await writePipelineStage("B", date, data, {
    durationMs,
    errors,
    rowCount: Object.keys(data.commsMetricsByEntity).length,
  });
  return { durationMs, errors, rowCount: Object.keys(data.commsMetricsByEntity).length };
}

// ===========================================================================
// STAGE B-V2 — bulk-events Metabase question → comms_events Postgres + derived
//              CustomerMetrics. Runs in its OWN function instance to keep
//              memory separated from V1.
// ===========================================================================

/**
 * Phase E-19 W1.8 — V2 comms ingest. Pure replacement for Stage B's V1 5-CSV
 * pipeline, just running in a separate function instance so the memory
 * budgets don't compete. Reads activeEntityIds from Stage A, fetches the
 * bulk-events Metabase question, upserts into comms_events, derives
 * per-entity CustomerMetrics, and writes watermarks.
 */
export async function runStageBV2(
  activeEntityIds: string[],
  today: number = todayMs(),
): Promise<{
  data: StageB2Data;
  durationMs: number;
  errors: string[];
}> {
  const started = Date.now();
  const errors: string[] = [];
  memSnap("B-v2 start");

  if (activeEntityIds.length === 0) {
    return {
      data: {
        commsMetricsByEntityV2: {},
        v2Diagnostics: {
          eventCount: 0,
          entitiesWithEventsV2: 0,
          fetchDurationMs: 0,
          upsertDurationMs: 0,
          deriveDurationMs: 0,
          softFailReason: "no activeEntityIds passed (Stage A may not have run)",
        },
      },
      durationMs: Date.now() - started,
      errors,
    };
  }

  let softFailReason: string | null = null;
  let eventCount = 0;
  let entitiesWithEventsV2 = 0;
  let fetchDurationMs = 0;
  let upsertDurationMs = 0;
  let deriveDurationMs = 0;
  let commsMetricsByEntityV2: Record<string, CustomerMetrics> = {};

  try {
    // Fetch via Metabase Dataset API (chunked + parallel, see comms-bulk-fetch.ts)
    const tFetch = Date.now();
    const events: CommsEventRow[] = await fetchBulkCommsEvents(activeEntityIds, 90);
    fetchDurationMs = Date.now() - tFetch;
    eventCount = events.length;
    memSnap(`B-v2 after fetch (${eventCount} events)`);

    if (events.length === 0) {
      softFailReason = "bulk fetch returned 0 events";
    } else {
      // Upsert to Postgres
      const tUpsert = Date.now();
      const { written, skipped } = await upsertCommsEvents(events);
      upsertDurationMs = Date.now() - tUpsert;
      if (skipped > 0) {
        console.warn(`[stageB-v2] upsert skipped ${skipped} events with missing required fields`);
      }
      console.log(`[stageB-v2] upserted ${written} events in ${upsertDurationMs}ms`);
      memSnap(`B-v2 after upsert`);

      // Group events by entity for derivation + watermark
      const byEntityV2 = new Map<string, CommsEventRow[]>();
      for (const e of events) {
        const arr = byEntityV2.get(e.entity_id) || [];
        arr.push(e);
        byEntityV2.set(e.entity_id, arr);
      }
      entitiesWithEventsV2 = byEntityV2.size;

      // Derive metrics
      const tDerive = Date.now();
      const now = new Date(today);
      for (const eid of activeEntityIds) {
        const evs = byEntityV2.get(eid) || [];
        commsMetricsByEntityV2[eid] = deriveCustomerMetricsFromEvents(evs, now);
      }
      deriveDurationMs = Date.now() - tDerive;

      // Watermarks
      const watermarks: Array<{
        entity_id: string;
        last_event_at: string | null;
        event_count_90d: number;
      }> = [];
      for (const eid of activeEntityIds) {
        const evs = byEntityV2.get(eid) || [];
        const last = evs.length > 0
          ? evs.reduce((acc, e) => (e.created_at > acc ? e.created_at : acc), evs[0].created_at)
          : null;
        watermarks.push({
          entity_id: eid,
          last_event_at: last,
          event_count_90d: evs.length,
        });
      }
      await writeWatermarks(watermarks).catch((e: Error) => {
        console.warn(`[stageB-v2] watermark write soft-failed: ${e.message}`);
      });
      memSnap(`B-v2 end`);
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    softFailReason = `v2 ingest threw: ${message}`;
    errors.push(softFailReason);
    console.error(`[stageB-v2] ${softFailReason}`);
  }

  const data: StageB2Data = {
    commsMetricsByEntityV2,
    v2Diagnostics: {
      eventCount,
      entitiesWithEventsV2,
      fetchDurationMs,
      upsertDurationMs,
      deriveDurationMs,
      softFailReason,
    },
  };

  console.log(
    `[stageB-v2] complete in ${Date.now() - started}ms — ` +
      `events=${eventCount}, entities_with_events=${entitiesWithEventsV2}, ` +
      `fetch=${fetchDurationMs}ms upsert=${upsertDurationMs}ms derive=${deriveDurationMs}ms` +
      (softFailReason ? ` SOFT-FAIL: ${softFailReason}` : ""),
  );

  return { data, durationMs: Date.now() - started, errors };
}

export async function runStageBV2AndStore(snapshotDate?: string): Promise<{
  durationMs: number;
  errors: string[];
  rowCount: number;
}> {
  const date = snapshotDate ?? todaySnapshotDate();
  const stageA = await readPipelineStage<StageAData>("A", date);
  const anchorToday = stageA?.data?.todayMs ?? todayMs();
  const activeEntityIds = stageA?.data?.activeEntityIds ?? [];
  const { data, durationMs, errors } = await runStageBV2(activeEntityIds, anchorToday);
  await writePipelineStage("B2", date, data, {
    durationMs,
    errors,
    rowCount: Object.keys(data.commsMetricsByEntityV2).length,
  });
  return {
    durationMs,
    errors,
    rowCount: Object.keys(data.commsMetricsByEntityV2).length,
  };
}

export async function runStageCAndStore(snapshotDate?: string): Promise<{
  durationMs: number;
  errors: string[];
  rowCount: number;
}> {
  const date = snapshotDate ?? todaySnapshotDate();
  const stageA = await readPipelineStage<StageAData>("A", date);
  const anchorToday = stageA?.data?.todayMs ?? todayMs();
  const { data, durationMs, errors } = await runStageC(anchorToday);
  await writePipelineStage("C", date, data, {
    durationMs,
    errors,
    rowCount: Object.keys(data.usageMetricsByEntity).length,
  });
  return { durationMs, errors, rowCount: Object.keys(data.usageMetricsByEntity).length };
}

export async function runStageDAndStore(snapshotDate?: string): Promise<{
  durationMs: number;
  errors: string[];
  rowCount: number;
}> {
  const date = snapshotDate ?? todaySnapshotDate();
  const stageA = await readPipelineStage<StageAData>("A", date);
  const anchorToday = stageA?.data?.todayMs ?? todayMs();
  try {
    const { data, durationMs, errors } = await runStageD(anchorToday);
    await writePipelineStage("D", date, data, {
      durationMs,
      errors,
      rowCount: Object.keys(data.companiesByPlaceId).length,
    });
    return { durationMs, errors, rowCount: Object.keys(data.companiesByPlaceId).length };
  } catch (e) {
    // Phase E-11 (G5) — atomic Stage D abort. Fire-and-forget Slack alert +
    // Sentry capture so we know HubSpot pipeline broke. The cron route reports
    // a 500, composeSnapshot will fall back to yesterday's Stage D, and the
    // V2Dashboard banner will show the structured reason.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[stage-d abort] ${msg}`);
    try {
      const Sentry = require("@sentry/nextjs");
      if (Sentry?.captureException) {
        Sentry.captureException(e, {
          level: "error",
          tags: { kind: "stage_d_abort", snapshot_date: date },
        });
      }
    } catch {
      /* Sentry unavailable */
    }
    // FIX-C: extract the failing phase from the thrown message so the
    // Slack alert is triage-ready. Format: "Stage D aborted — HubSpot
    // <phase> fetch failed: <inner>" → phase = "companies" / "deals" /
    // "calls/contacts" / "notes" etc. Fall through to "unknown" if the
    // shape doesn't match (e.g. DB write failure).
    const phaseMatch = msg.match(/HubSpot ([\w/]+) fetch failed/i);
    const phase = phaseMatch ? phaseMatch[1] : "unknown";
    postSlack({
      text: `:rotating_light: *Beacon Stage D aborted*: ${phase} — ${msg}`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: ":rotating_light: Beacon — Stage D (HubSpot) aborted" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `*Snapshot date*: \`${date}\`\n` +
              `*Failing phase*: \`${phase}\`\n` +
              `*Reason*: ${msg}\n\n` +
              `After FIX-A/B/C only a wholesale *companies* fetch failure trips this. ` +
              `deals/notes/calls/contacts now soft-fail with structured banner reasons. ` +
              `Compose will fall back to yesterday's Stage D if available. AMs see a staleness banner with the specific failing source.`,
          },
        },
      ],
    }).catch(() => {
      /* never crash on Slack hiccups */
    });
    throw e;
  }
}

// ===========================================================================
// Legacy single-shot orchestrator
// ===========================================================================

export async function buildSnapshotV2(): Promise<SnapshotV2> {
  const date = todaySnapshotDate();
  await runStageAAndStore(date);
  await runStageBAndStore(date);
  await runStageCAndStore(date);
  return composeSnapshot(date);
}

/**
 * v1 wrapper — kept so the existing /api/snapshot endpoint and v1 UI keep
 * rendering. Returns the v1-shaped subset of the v2 snapshot.
 */
export async function buildSnapshot(): Promise<Snapshot> {
  const v2 = await buildSnapshotV2();
  const customersV1: ScoredCustomer[] = v2.customers.map((c) => ({
    customer_id: c.customer_id,
    entity_id: c.entity_id,
    subscription_id: c.subscription_id,
    company: c.company,
    email: c.email,
    phone: c.phone,
    am_name: c.am_name,
    ae_name: c.ae_name,
    sp_name: c.sp_name,
    cb_status: c.cb_status,
    auto_collection: c.auto_collection,
    plan_amount: c.plan_amount,
    mrr_basesheet: c.mrr_basesheet,
    zoca_status: c.zoca_status,
    churn_potential_flag: c.churn_potential_flag,
    activated_at: c.activated_at,
    ob_date: c.ob_date,
    match_source: c.match_source,
    in_chrone: c.in_chrone,
    metrics: c.metrics,
    signals: c.signals,
  }));
  return {
    generatedAt: v2.generatedAt,
    todayIso: v2.todayIso,
    totalActive: v2.totalActive,
    tierCounts: v2.tierCounts,
    signalCounts: v2.signalCounts,
    channelCounts: v2.channelCounts,
    amExposure: v2.amExposure,
    amTierBreakdown: v2.amTierBreakdown,
    scoreDistribution: v2.scoreDistribution,
    customers: customersV1,
    stats: v2.stats,
    health: v2.health,
    errors: v2.errors,
  };
}

export { buildBillingMetrics, fetchUnpaidInvoices, fetchRecentTransactions } from "./billing";
export { fetchUsageMetrics } from "./mixpanel";
export { fetchPerformanceMetrics } from "./performance";
