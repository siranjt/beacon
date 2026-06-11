/**
 * Phase E-17 Wave 3b — Proactive Beam runners.
 *
 * Shared logic for the two proactive cron routes:
 *   • Monday briefing — top-5 actions for the week, voiced for each AM.
 *   • Daily anomaly digest — what changed in their book overnight.
 *
 * The cron routes are thin shells; everything substantive lives here so
 * tests + dry-run / manual triggers can call directly.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logSpend, extractUsage } from "./spend-log";
import { AM_EMAILS, AM_SLACK_IDS } from "@/lib/customer/config";
import { readLatestSnapshotV2, readSnapshotByDate } from "@/lib/customer/postgres";
import { resolveAmNameForEmail } from "@/lib/customer/auth-mapping";
import { listFactsForUser, renderFactsForPrompt } from "@/lib/ai/facts";
import { listActiveSnoozes } from "@/lib/customer/snooze";
import { listPinned } from "@/lib/customer/pinned-customers";
import { logUmbrellaActivity } from "@/lib/activity/log";
import { postSlackDm, slackDmConfigured } from "@/lib/slack-dm";
import {
  buildMondayBriefingPrompt,
  buildDailyDigestPrompt,
  type BriefingTopCustomer,
  type BookAggregates,
  type DailyChange,
  type DailyDigestSummary,
  type MissPaymentAmSummary,
} from "@/lib/ai/proactive-prompts";
import type { ScoredCustomerV2, SnapshotV2 } from "@/lib/customer/types";
// Phase F-polish-AI-5 — fetch the full miss-payment book once per cron
// run, slice per AM. Each AM's briefing then gets concrete unpaid-invoice
// numbers for their book without 13 separate Chargebee pulls.
import {
  fetchOpenInvoices as fetchMpInvoices,
  fetchInProgressTransactions as fetchMpAchTx,
  fetchCustomers as fetchMpCustomers,
  fetchSubscriptions as fetchMpSubs,
} from "@/lib/miss-payment/chargebee";
import {
  fetchBaseSheet as fetchMpBaseSheet,
  indexBaseSheet as indexMpBaseSheet,
} from "@/lib/miss-payment/basesheet";
import {
  buildInvoiceRows as buildMpInvoiceRows,
  multiMonthCustomerIds as mpMultiMonthCustomerIds,
} from "@/lib/miss-payment/enrich";
import type { InvoiceRow as MpInvoiceRow } from "@/lib/miss-payment/types";

const PROACTIVE_MODEL =
  process.env.ANTHROPIC_PROACTIVE_MODEL ?? "claude-haiku-4-5-20251001";

// Slack rate-limit pacing — Slack's chat.postMessage allows ~1/sec/channel
// for normal posting; we DM unique users so we're well under, but the spec
// asks for 1100ms between sends to be safe.
const SLACK_DM_INTERVAL_MS = 1_100;

// Daily digest "material change" thresholds.
const DAILY_SCORE_DROP_MIN = 10; // composite delta worse than -10 → surface
const DAILY_TICKET_NEW_HOURS = 24; // ticket opened within last 24h
const DAILY_DIGEST_PROMPT_MAX_TOKENS = 600;
const MONDAY_BRIEFING_PROMPT_MAX_TOKENS = 800;
const TOP_N_BRIEFING_CUSTOMERS = 5;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Telemetry types
// ---------------------------------------------------------------------------

export type ProactiveStatus =
  | "sent"
  | "skipped:no_am_name"
  | "skipped:empty_book"
  | "skipped:no_slack_id"
  | "skipped:no_changes"
  | "skipped:dry_run"
  | "skipped:no_anthropic_key"
  | "error";

export type ProactiveResult<Body> = {
  kind: "monday_briefing" | "daily_digest";
  am_email: string;
  am_name: string | null;
  status: ProactiveStatus;
  top_n_entity_ids: string[];
  error?: string;
  /** Rendered Slack DM body — present on success + dry_run. */
  body?: string;
  /** Diagnostic counts so we can see at a glance what fired. */
  meta?: Body;
};

// ---------------------------------------------------------------------------
// Helpers — selecting + shaping a single AM's data
// ---------------------------------------------------------------------------

function isHealthTierRed(tier: string | null | undefined): boolean {
  return tier === "CRITICAL - DEAL BREAKER" || tier === "CRITICAL" || tier === "AT-RISK";
}

function isHealthTierYellow(tier: string | null | undefined): boolean {
  // Same convention as lib/customer/slack-digest.ts — MONITOR + blank = YELLOW.
  return tier === "MONITOR" || tier === "" || tier == null;
}

function tierFromCustomer(c: ScoredCustomerV2): "RED" | "YELLOW" | "GREEN" {
  // Phase 33.E.2 Metabase health tier rules mirror lib/customer/slack-digest.ts.
  const ht = String(
    (c as unknown as { metabase_health?: { health_tier?: string } }).metabase_health
      ?.health_tier || "",
  );
  if (isHealthTierRed(ht)) return "RED";
  if (isHealthTierYellow(ht)) return "YELLOW";
  // Defer to the underlying v2 stoplight if no health tier mapped.
  return c.signals_v2?.stoplight ?? "GREEN";
}

function bookAggregatesFor(customers: ScoredCustomerV2[]): BookAggregates {
  let red = 0;
  let yellow = 0;
  let green = 0;
  for (const c of customers) {
    const t = tierFromCustomer(c);
    if (t === "RED") red++;
    else if (t === "YELLOW") yellow++;
    else green++;
  }
  return {
    total_active: customers.length,
    red_count: red,
    yellow_count: yellow,
    green_count: green,
  };
}

function pickTop5ForBriefing(visible: ScoredCustomerV2[]): ScoredCustomerV2[] {
  // Worst composite first, tiebreak by days_since_out desc.
  const ranked = [...visible].sort((a, b) => {
    const ca = b.signals_v2?.composite ?? 0;
    const cb = a.signals_v2?.composite ?? 0;
    const compositeOrder = ca - cb;
    if (compositeOrder !== 0) return compositeOrder;
    const da = a.metrics?.days_since_out ?? 0;
    const db = b.metrics?.days_since_out ?? 0;
    // Treat the 9999 sentinel as "no data" — sort lower than real values.
    const aval = da >= 9999 ? -1 : da;
    const bval = db >= 9999 ? -1 : db;
    return bval - aval;
  });
  return ranked.slice(0, TOP_N_BRIEFING_CUSTOMERS);
}

function toBriefingTopCustomer(c: ScoredCustomerV2): BriefingTopCustomer {
  const composite = c.signals_v2?.composite ?? 0;
  const days = c.metrics?.days_since_out;
  const ticketsCount =
    c.tickets?.open_count ?? c.tickets?.open_tickets_30d ?? 0;
  const unpaid = c.billing?.unpaid_invoice_count ?? 0;
  return {
    bizname: c.company || "Unknown",
    entity_id: c.entity_id,
    composite,
    stoplight: tierFromCustomer(c),
    tier: c.signals_v2?.tier ?? "UNKNOWN",
    days_since_out:
      typeof days === "number" && days < 9999 && Number.isFinite(days)
        ? days
        : null,
    reason_one_line: c.signals_v2?.reason_one_line ?? "",
    open_tickets: ticketsCount,
    unpaid_invoice_count: unpaid,
    trajectory_7d: c.signals_v2?.trajectory_7d ?? null,
  };
}

/**
 * Filter snapshot.customers to a single AM's book, dropping snoozed +
 * pinned. Recently-churned customers are already excluded by the snapshot
 * compose step (F-purge-churned). Returns the AM-visible book.
 */
async function loadVisibleBookForAm(
  snapshot: SnapshotV2,
  amName: string,
): Promise<ScoredCustomerV2[]> {
  const ownBook = snapshot.customers.filter(
    (c) => (c.am_name || "").trim() === amName,
  );
  const [snoozed, pinned] = await Promise.all([
    listActiveSnoozes(amName).catch(() => []),
    listPinned(amName).catch(() => []),
  ]);
  const skipIds = new Set<string>([
    ...snoozed.map((s) => s.entity_id),
    ...pinned.map((p) => p.entity_id),
  ]);
  // F-purge-churned — snapshot already excludes recently-churned rows.
  return ownBook.filter((c) => !skipIds.has(c.entity_id));
}

// ---------------------------------------------------------------------------
// Haiku invocation
// ---------------------------------------------------------------------------

async function callHaiku(
  system: string,
  user: string,
  maxTokens: number,
  /**
   * META-A5 — pass through "monday-briefing" / "daily-digest" as the
   * feature label so the dashboard breaks the two crons apart.
   */
  feature: "monday-briefing" | "daily-digest" = "daily-digest",
): Promise<{ text: string } | { error: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { error: "ANTHROPIC_API_KEY not configured" };
  }
  try {
    const res = await anthropic.messages.create({
      model: PROACTIVE_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    void logSpend({
      feature,
      model: PROACTIVE_MODEL,
      ...extractUsage(res),
    });
    const text = res.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) return { error: "Haiku returned empty text" };
    return { text };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Monday briefing
// ---------------------------------------------------------------------------

export type MondayBriefingMeta = {
  book_total: number;
  red_count: number;
  yellow_count: number;
  green_count: number;
  considered: number;
  picked: number;
};

/**
 * Phase F-polish-AI-5 — fetch the full Miss Payment book once + index by
 * AM. Each AM's Monday briefing then gets a concrete unpaid-invoice slice
 * for their book without 13 separate Chargebee pulls. Falls back to null
 * (no miss-payment section in any briefing) if the Chargebee call fails
 * — the briefing should still ship.
 */
async function pullMissPaymentByAm(): Promise<Map<string, MissPaymentAmSummary> | null> {
  try {
    const [invoices, achTx, baseRows] = await Promise.all([
      fetchMpInvoices(),
      fetchMpAchTx(),
      fetchMpBaseSheet(),
    ]);
    const baseSheet = indexMpBaseSheet(baseRows);
    const customerIds = invoices.map((i: any) => i.customer_id).filter(Boolean);
    const subIds = invoices.map((i: any) => i.subscription_id).filter(Boolean);
    const [cbCustomers, cbSubs] = await Promise.all([
      fetchMpCustomers(customerIds),
      fetchMpSubs(subIds),
    ]);
    const rows: MpInvoiceRow[] = buildMpInvoiceRows({
      invoices,
      customers: cbCustomers,
      subs: cbSubs,
      achTransactions: achTx,
      baseSheet,
      ticketsByEntity: undefined,
    });
    const multiSet = mpMultiMonthCustomerIds(rows);

    // Group by AM name (case-sensitive — matches BaseSheet exactly). The
    // dashboard route uses the same convention, so per-AM slices line up
    // with what AMs see when they open /miss-payment themselves.
    const byAm = new Map<
      string,
      {
        rows: MpInvoiceRow[];
        multi_customers: Set<string>;
      }
    >();
    for (const r of rows) {
      const am = (r.amName || "").trim();
      if (!am) continue;
      if (!byAm.has(am)) byAm.set(am, { rows: [], multi_customers: new Set() });
      const entry = byAm.get(am)!;
      entry.rows.push(r);
      const key = r.entityId || r.customerId;
      if (multiSet.has(key)) entry.multi_customers.add(key);
    }

    const out = new Map<string, MissPaymentAmSummary>();
    for (const [am, entry] of byAm) {
      const total = entry.rows.reduce((s, r) => s + (r.amountDue || 0), 0);
      const autoOffHigh = entry.rows.filter(
        (r) => r.autoDebit === "Off" && (r.amountDue || 0) >= 500,
      ).length;
      const top3 = [...entry.rows]
        .sort((a, b) => (b.amountDue || 0) - (a.amountDue || 0))
        .slice(0, 3)
        .map((r) => ({
          biz_name: r.bizName,
          amount_due_usd: Math.round(r.amountDue),
          invoice_date: r.invoiceDate,
          auto_debit: r.autoDebit,
        }));
      out.set(am, {
        open_invoice_count: entry.rows.length,
        total_outstanding_usd: Math.round(total),
        multi_month_customer_count: entry.multi_customers.size,
        auto_debit_off_high_balance_count: autoOffHigh,
        top_3_invoices: top3,
      });
    }
    return out;
  } catch (err) {
    console.warn(
      "[proactive-beacon] miss-payment fetch failed; Monday briefings will omit the miss-payment section",
      err,
    );
    return null;
  }
}

export async function runMondayBriefingForAm(
  amEmail: string,
  snapshot: SnapshotV2,
  opts: {
    dryRun?: boolean;
    /** Optional per-cron-run map; absent = no miss-payment section. */
    missPaymentByAm?: Map<string, MissPaymentAmSummary> | null;
  } = {},
): Promise<ProactiveResult<MondayBriefingMeta>> {
  const amName = await resolveAmNameForEmail(amEmail).catch(() => null);
  if (!amName) {
    return {
      kind: "monday_briefing",
      am_email: amEmail,
      am_name: null,
      status: "skipped:no_am_name",
      top_n_entity_ids: [],
    };
  }

  const ownBook = snapshot.customers.filter(
    (c) => (c.am_name || "").trim() === amName,
  );
  if (ownBook.length === 0) {
    return {
      kind: "monday_briefing",
      am_email: amEmail,
      am_name: amName,
      status: "skipped:empty_book",
      top_n_entity_ids: [],
    };
  }

  const aggregates = bookAggregatesFor(ownBook);
  const visible = await loadVisibleBookForAm(snapshot, amName);
  const top5 = pickTop5ForBriefing(visible);
  const top5Shaped = top5.map(toBriefingTopCustomer);
  const topIds = top5.map((c) => c.entity_id);

  const meta: MondayBriefingMeta = {
    book_total: aggregates.total_active,
    red_count: aggregates.red_count,
    yellow_count: aggregates.yellow_count,
    green_count: aggregates.green_count,
    considered: visible.length,
    picked: top5.length,
  };

  if (top5.length === 0) {
    // Empty visible book (everything snoozed/pinned/recently-churned).
    return {
      kind: "monday_briefing",
      am_email: amEmail,
      am_name: amName,
      status: "skipped:empty_book",
      top_n_entity_ids: [],
      meta,
    };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      kind: "monday_briefing",
      am_email: amEmail,
      am_name: amName,
      status: "skipped:no_anthropic_key",
      top_n_entity_ids: topIds,
      meta,
    };
  }

  const facts = await listFactsForUser(amEmail, {}).catch(() => []);
  const factsBlock = renderFactsForPrompt(facts);
  // Phase F-polish-AI-5 — resolve this AM's miss-payment slice from the
  // per-cron-run map. Null = no map was passed (e.g. unit-test caller) OR
  // this AM has zero unpaid invoices. Either way the briefing renders
  // cleanly without the section.
  const amMissPayment = opts.missPaymentByAm?.get(amName) ?? null;
  const { system, user } = buildMondayBriefingPrompt(
    amName,
    top5Shaped,
    aggregates,
    factsBlock,
    amMissPayment,
  );
  const llm = await callHaiku(
    system,
    user,
    MONDAY_BRIEFING_PROMPT_MAX_TOKENS,
    "monday-briefing",
  );
  if ("error" in llm) {
    return {
      kind: "monday_briefing",
      am_email: amEmail,
      am_name: amName,
      status: "error",
      top_n_entity_ids: topIds,
      error: llm.error,
      meta,
    };
  }
  const body = llm.text;

  if (opts.dryRun) {
    return {
      kind: "monday_briefing",
      am_email: amEmail,
      am_name: amName,
      status: "skipped:dry_run",
      top_n_entity_ids: topIds,
      body,
      meta,
    };
  }

  const slackUserId = AM_SLACK_IDS[amEmail];
  if (!slackUserId) {
    return {
      kind: "monday_briefing",
      am_email: amEmail,
      am_name: amName,
      status: "skipped:no_slack_id",
      top_n_entity_ids: topIds,
      body,
      meta,
    };
  }

  const post = await postSlackDm(slackUserId, { text: body });
  if (!post.ok) {
    return {
      kind: "monday_briefing",
      am_email: amEmail,
      am_name: amName,
      status: "error",
      top_n_entity_ids: topIds,
      error: post.error,
      body,
      meta,
    };
  }

  return {
    kind: "monday_briefing",
    am_email: amEmail,
    am_name: amName,
    status: "sent",
    top_n_entity_ids: topIds,
    body,
    meta,
  };
}

export type MondayBriefingRunResult = {
  dryRun: boolean;
  slackConfigured: boolean;
  count_total: number;
  count_sent: number;
  count_skipped: number;
  count_errors: number;
  results: ProactiveResult<MondayBriefingMeta>[];
};

export async function runMondayBriefingForAllAms(opts: {
  dryRun?: boolean;
} = {}): Promise<MondayBriefingRunResult> {
  const dryRun = !!opts.dryRun;
  const snapshot = await readLatestSnapshotV2();
  if (!snapshot) {
    return {
      dryRun,
      slackConfigured: slackDmConfigured(),
      count_total: 0,
      count_sent: 0,
      count_skipped: 0,
      count_errors: 0,
      results: [],
    };
  }

  // Phase F-polish-AI-5 — single Chargebee pull, then slice per AM. The
  // briefing fan-out re-uses the same map across all 13 AMs instead of
  // 13 separate Chargebee round-trips. Failure here is non-fatal — the
  // briefing renders cleanly without the miss-payment section.
  const missPaymentByAm = await pullMissPaymentByAm();

  const results: ProactiveResult<MondayBriefingMeta>[] = [];
  for (const email of AM_EMAILS) {
    const r = await runMondayBriefingForAm(email, snapshot, {
      dryRun,
      missPaymentByAm,
    });
    results.push(r);

    // Telemetry — write one row per AM (success OR skip OR error).
    void logUmbrellaActivity({
      email,
      role: "am",
      am_name: r.am_name,
      agent: "customer",
      event_name: "beacon_ai:proactive:monday_briefing",
      surface: "v2_dashboard",
      entity_id: null,
      metadata: {
        kind: "monday_briefing",
        status: r.status,
        am_name: r.am_name,
        top_5_entity_ids: r.top_n_entity_ids,
        customer_count: r.meta?.book_total ?? 0,
        red_count: r.meta?.red_count ?? 0,
        yellow_count: r.meta?.yellow_count ?? 0,
        green_count: r.meta?.green_count ?? 0,
        dry_run: dryRun,
        error: r.error ?? null,
      },
    });

    // Pace Slack DMs at ~1/sec. Only pace when we actually posted (or would have)
    // — skipping a row is free, and we don't want to add 1s/AM to a dry run.
    if (!dryRun && r.status === "sent") {
      await sleep(SLACK_DM_INTERVAL_MS);
    }
  }

  return {
    dryRun,
    slackConfigured: slackDmConfigured(),
    count_total: results.length,
    count_sent: results.filter((r) => r.status === "sent").length,
    count_skipped: results.filter((r) => r.status.startsWith("skipped:")).length,
    count_errors: results.filter((r) => r.status === "error").length,
    results,
  };
}

// ---------------------------------------------------------------------------
// Daily anomaly digest
// ---------------------------------------------------------------------------

export type DailyDigestMeta = {
  changes_total: number;
  score_drops: number;
  tier_flips_worse: number;
  tier_flips_better: number;
  new_tickets: number;
  new_missed_payments: number;
  no_yesterday_snapshot: boolean;
};

/**
 * Compute per-customer changes for one AM. Diff today's snapshot against
 * yesterday's. Surfaces "material" change as defined by:
 *   - composite drop > DAILY_SCORE_DROP_MIN (worsening)
 *   - tier flip worsening (GREEN→YELLOW, GREEN→RED, YELLOW→RED)
 *   - tier flip improving RED→YELLOW (surfaced as a "win" line)
 *   - new ticket created within last DAILY_TICKET_NEW_HOURS
 *   - new missed payment: unpaid_invoice_count increased OR days_past_oldest_unpaid
 *     went from 0 → positive
 */
function computeChangesForAm(
  todayBook: ScoredCustomerV2[],
  yesterdayByEntityId: Map<string, ScoredCustomerV2>,
): {
  changes: DailyChange[];
  summary: Omit<DailyDigestSummary, "no_yesterday_snapshot">;
} {
  const changes: DailyChange[] = [];
  let score_drops = 0;
  let tier_flips_worse = 0;
  let tier_flips_better = 0;
  let new_tickets = 0;
  let new_missed_payments = 0;
  const cutoffMs = Date.now() - DAILY_TICKET_NEW_HOURS * 3600 * 1000;

  for (const today of todayBook) {
    const prev = yesterdayByEntityId.get(today.entity_id);
    const todayTier = tierFromCustomer(today);
    const todayComposite = today.signals_v2?.composite ?? 0;
    const biz = today.company || "Unknown";

    // --- score drop ---
    if (prev) {
      const prevComposite = prev.signals_v2?.composite ?? 0;
      const delta = todayComposite - prevComposite;
      // delta is on a 0-100 risk scale — UP is worse. A drop > threshold means
      // the customer's risk went UP by more than DAILY_SCORE_DROP_MIN points.
      if (delta >= DAILY_SCORE_DROP_MIN) {
        changes.push({
          bizname: biz,
          entity_id: today.entity_id,
          kind: "score_drop",
          detail: `composite ${prevComposite} → ${todayComposite} (+${delta})${
            today.signals_v2?.reason_one_line
              ? " — " + today.signals_v2.reason_one_line
              : ""
          }`,
          stoplight_today: todayTier,
          composite_today: todayComposite,
          composite_yesterday: prevComposite,
          composite_delta: delta,
        });
        score_drops++;
      }
    }

    // --- tier flip ---
    if (prev) {
      const prevTier = tierFromCustomer(prev);
      const order: Record<"RED" | "YELLOW" | "GREEN", number> = {
        GREEN: 0,
        YELLOW: 1,
        RED: 2,
      };
      if (prevTier !== todayTier) {
        if (order[todayTier] > order[prevTier]) {
          changes.push({
            bizname: biz,
            entity_id: today.entity_id,
            kind: "tier_flip_worse",
            detail: `flipped ${prevTier} → ${todayTier}`,
            stoplight_today: todayTier,
            composite_today: todayComposite,
          });
          tier_flips_worse++;
        } else if (prevTier === "RED" && todayTier === "YELLOW") {
          // Only surface RED→YELLOW as a win; quieter improvements are noise.
          changes.push({
            bizname: biz,
            entity_id: today.entity_id,
            kind: "tier_flip_better",
            detail: `recovering — RED → YELLOW`,
            stoplight_today: todayTier,
            composite_today: todayComposite,
          });
          tier_flips_better++;
        }
      }
    }

    // --- new tickets opened in last 24h ---
    const ticketRecords = today.tickets?.records ?? [];
    const recentTickets = ticketRecords.filter((t) => {
      const created = Date.parse(t.created_at);
      return Number.isFinite(created) && created >= cutoffMs && !t.is_closed;
    });
    if (recentTickets.length > 0) {
      const sample = recentTickets[0];
      const more = recentTickets.length - 1;
      const detail = `${recentTickets.length} new ticket${
        recentTickets.length === 1 ? "" : "s"
      } overnight — \`${sample.id}\` "${sample.title.slice(0, 80)}"${
        more > 0 ? ` (+${more} more)` : ""
      }`;
      changes.push({
        bizname: biz,
        entity_id: today.entity_id,
        kind: "new_ticket",
        detail,
        stoplight_today: todayTier,
        composite_today: todayComposite,
      });
      new_tickets += recentTickets.length;
    }

    // --- new missed payment ---
    if (prev) {
      const todayUnpaid = today.billing?.unpaid_invoice_count ?? 0;
      const prevUnpaid = prev.billing?.unpaid_invoice_count ?? 0;
      const todayOverdue = today.billing?.days_past_oldest_unpaid ?? 0;
      const prevOverdue = prev.billing?.days_past_oldest_unpaid ?? 0;
      const newInvoice = todayUnpaid > prevUnpaid;
      const justWentOverdue = prevOverdue === 0 && todayOverdue > 0;
      if (newInvoice || justWentOverdue) {
        const detail = newInvoice
          ? `unpaid invoices ${prevUnpaid} → ${todayUnpaid}${
              todayOverdue > 0 ? ` · ${todayOverdue}d past due` : ""
            }`
          : `oldest unpaid just crossed due date — ${todayOverdue}d past due`;
        changes.push({
          bizname: biz,
          entity_id: today.entity_id,
          kind: "new_missed_payment",
          detail,
          stoplight_today: todayTier,
          composite_today: todayComposite,
        });
        new_missed_payments++;
      }
    }
  }

  // Sort by priority — score_drop / tier_flip_worse / new_missed_payment /
  // new_ticket / tier_flip_better. Within same kind, by today's composite
  // descending (worst first).
  const kindOrder: Record<DailyChange["kind"], number> = {
    score_drop: 0,
    tier_flip_worse: 1,
    new_missed_payment: 2,
    new_ticket: 3,
    tier_flip_better: 4,
  };
  changes.sort((a, b) => {
    const ko = kindOrder[a.kind] - kindOrder[b.kind];
    if (ko !== 0) return ko;
    return (b.composite_today ?? 0) - (a.composite_today ?? 0);
  });

  return {
    changes,
    summary: {
      total_changes: changes.length,
      score_drops,
      tier_flips_worse,
      tier_flips_better,
      new_tickets,
      new_missed_payments,
    },
  };
}

export async function runDailyDigestForAm(
  amEmail: string,
  todaySnapshot: SnapshotV2,
  yesterdaySnapshot: SnapshotV2 | null,
  opts: {
    dryRun?: boolean;
    /** Phase F-polish-AI-5b — per-AM miss-payment book snapshot. */
    missPaymentByAm?: Map<string, MissPaymentAmSummary> | null;
  } = {},
): Promise<ProactiveResult<DailyDigestMeta>> {
  const amName = await resolveAmNameForEmail(amEmail).catch(() => null);
  if (!amName) {
    return {
      kind: "daily_digest",
      am_email: amEmail,
      am_name: null,
      status: "skipped:no_am_name",
      top_n_entity_ids: [],
    };
  }

  const ownBook = todaySnapshot.customers.filter(
    (c) => (c.am_name || "").trim() === amName,
  );
  if (ownBook.length === 0) {
    return {
      kind: "daily_digest",
      am_email: amEmail,
      am_name: amName,
      status: "skipped:empty_book",
      top_n_entity_ids: [],
    };
  }

  const visible = await loadVisibleBookForAm(todaySnapshot, amName);

  let summary: DailyDigestSummary;
  let changes: DailyChange[];
  if (!yesterdaySnapshot) {
    // First run / yesterday missing — short-circuit to a courteous first-run
    // message via the prompt's no_yesterday_snapshot branch.
    changes = [];
    summary = {
      total_changes: 0,
      score_drops: 0,
      tier_flips_worse: 0,
      tier_flips_better: 0,
      new_tickets: 0,
      new_missed_payments: 0,
      no_yesterday_snapshot: true,
    };
  } else {
    const yesterdayMap = new Map<string, ScoredCustomerV2>();
    for (const c of yesterdaySnapshot.customers) {
      // Index BY entity_id (snapshot truth) regardless of AM ownership — the
      // book could have shifted overnight (AM transition) but the customer's
      // composite history still lives in yesterday's row.
      yesterdayMap.set(c.entity_id, c);
    }
    const computed = computeChangesForAm(visible, yesterdayMap);
    changes = computed.changes;
    summary = { ...computed.summary, no_yesterday_snapshot: false };
  }

  const meta: DailyDigestMeta = {
    changes_total: summary.total_changes,
    score_drops: summary.score_drops,
    tier_flips_worse: summary.tier_flips_worse,
    tier_flips_better: summary.tier_flips_better,
    new_tickets: summary.new_tickets,
    new_missed_payments: summary.new_missed_payments,
    no_yesterday_snapshot: summary.no_yesterday_snapshot,
  };

  // Quiet day with a healthy "yesterday" anchor → skip.
  // We DO want to DM the first-run notice when no_yesterday_snapshot is true.
  if (summary.total_changes === 0 && !summary.no_yesterday_snapshot) {
    return {
      kind: "daily_digest",
      am_email: amEmail,
      am_name: amName,
      status: "skipped:no_changes",
      top_n_entity_ids: [],
      meta,
    };
  }

  const topIds = changes.slice(0, 10).map((c) => c.entity_id);

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      kind: "daily_digest",
      am_email: amEmail,
      am_name: amName,
      status: "skipped:no_anthropic_key",
      top_n_entity_ids: topIds,
      meta,
    };
  }

  const facts = await listFactsForUser(amEmail, {}).catch(() => []);
  const factsBlock = renderFactsForPrompt(facts);
  // Phase F-polish-AI-5b — per-AM miss-payment slice for the opener. Same
  // shape used by the Monday briefing; null when no map was passed OR the
  // AM has zero unpaid invoices.
  const amMissPayment = opts.missPaymentByAm?.get(amName) ?? null;
  const { system, user } = buildDailyDigestPrompt(
    amName,
    changes,
    summary,
    factsBlock,
    amMissPayment,
  );
  const llm = await callHaiku(
    system,
    user,
    DAILY_DIGEST_PROMPT_MAX_TOKENS,
    "daily-digest",
  );
  if ("error" in llm) {
    return {
      kind: "daily_digest",
      am_email: amEmail,
      am_name: amName,
      status: "error",
      top_n_entity_ids: topIds,
      error: llm.error,
      meta,
    };
  }
  const body = llm.text;

  if (opts.dryRun) {
    return {
      kind: "daily_digest",
      am_email: amEmail,
      am_name: amName,
      status: "skipped:dry_run",
      top_n_entity_ids: topIds,
      body,
      meta,
    };
  }

  const slackUserId = AM_SLACK_IDS[amEmail];
  if (!slackUserId) {
    return {
      kind: "daily_digest",
      am_email: amEmail,
      am_name: amName,
      status: "skipped:no_slack_id",
      top_n_entity_ids: topIds,
      body,
      meta,
    };
  }
  const post = await postSlackDm(slackUserId, { text: body });
  if (!post.ok) {
    return {
      kind: "daily_digest",
      am_email: amEmail,
      am_name: amName,
      status: "error",
      top_n_entity_ids: topIds,
      error: post.error,
      body,
      meta,
    };
  }

  return {
    kind: "daily_digest",
    am_email: amEmail,
    am_name: amName,
    status: "sent",
    top_n_entity_ids: topIds,
    body,
    meta,
  };
}

export type DailyDigestRunResult = {
  dryRun: boolean;
  slackConfigured: boolean;
  yesterday_date: string | null;
  yesterday_snapshot_found: boolean;
  count_total: number;
  count_sent: number;
  count_skipped: number;
  count_errors: number;
  results: ProactiveResult<DailyDigestMeta>[];
};

export async function runDailyDigestForAllAms(opts: {
  dryRun?: boolean;
} = {}): Promise<DailyDigestRunResult> {
  const dryRun = !!opts.dryRun;
  const today = await readLatestSnapshotV2();
  if (!today) {
    return {
      dryRun,
      slackConfigured: slackDmConfigured(),
      yesterday_date: null,
      yesterday_snapshot_found: false,
      count_total: 0,
      count_sent: 0,
      count_skipped: 0,
      count_errors: 0,
      results: [],
    };
  }

  // Compute yesterday's date as (today's snapshot date - 1d). Source of truth
  // is the snapshot's generatedAt, not the wall clock — guards against weird
  // edge cases where today's snapshot didn't land yet.
  const todayDate = today.generatedAt.slice(0, 10);
  const yesterdayDate = new Date(
    new Date(todayDate + "T00:00:00Z").getTime() - 24 * 3600 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const yesterday = await readSnapshotByDate(yesterdayDate);

  // Phase F-polish-AI-5b — single Chargebee pull, slice per AM. Same
  // helper used by the Monday briefing fan-out. Failure here is non-
  // fatal — digest renders without the book-level miss-payment line.
  const missPaymentByAm = await pullMissPaymentByAm();

  const results: ProactiveResult<DailyDigestMeta>[] = [];
  for (const email of AM_EMAILS) {
    const r = await runDailyDigestForAm(email, today, yesterday, {
      dryRun,
      missPaymentByAm,
    });
    results.push(r);

    void logUmbrellaActivity({
      email,
      role: "am",
      am_name: r.am_name,
      agent: "customer",
      event_name: "beacon_ai:proactive:daily_digest",
      surface: "v2_dashboard",
      entity_id: null,
      metadata: {
        kind: "daily_digest",
        status: r.status,
        am_name: r.am_name,
        top_n_entity_ids: r.top_n_entity_ids,
        changes_total: r.meta?.changes_total ?? 0,
        score_drops: r.meta?.score_drops ?? 0,
        tier_flips_worse: r.meta?.tier_flips_worse ?? 0,
        tier_flips_better: r.meta?.tier_flips_better ?? 0,
        new_tickets: r.meta?.new_tickets ?? 0,
        new_missed_payments: r.meta?.new_missed_payments ?? 0,
        yesterday_date: yesterdayDate,
        no_yesterday_snapshot: r.meta?.no_yesterday_snapshot ?? !yesterday,
        dry_run: dryRun,
        error: r.error ?? null,
      },
    });

    if (!dryRun && r.status === "sent") {
      await sleep(SLACK_DM_INTERVAL_MS);
    }
  }

  return {
    dryRun,
    slackConfigured: slackDmConfigured(),
    yesterday_date: yesterdayDate,
    yesterday_snapshot_found: !!yesterday,
    count_total: results.length,
    count_sent: results.filter((r) => r.status === "sent").length,
    count_skipped: results.filter((r) => r.status.startsWith("skipped:")).length,
    count_errors: results.filter((r) => r.status === "error").length,
    results,
  };
}
