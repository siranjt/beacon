/**
 * Beacon AI inline citations — Phase E-17 Wave 3a, Feature 1.
 *
 * When Beacon AI makes a factual claim grounded in the CONTEXT, it embeds a
 * marker like `[cite:KEY]` directly in its response text. The client parses
 * these markers, renders them as small clickable chips next to the claim,
 * and shows a popover with the source data when clicked.
 *
 * Citation key syntax (canonical):
 *   [cite:<category>:<identifier>]
 *
 * Categories:
 *   - signal   — a customer signal/flag. id = "<signal_name>:<entity_id>"
 *   - metric   — a numeric score or count. id = "<metric_name>:<entity_id>"
 *   - ticket   — a Linear/HubSpot ticket. id = "<ticket_identifier>"
 *   - billing  — a Chargebee event. id = "<event_name>:<entity_id>"
 *   - comm     — a comm event. id = "<comm_type>:<entity_id>"
 *   - usage    — a Mixpanel usage event. id = "<event_name>:<entity_id>"
 *   - count    — a derived count. id = "<readable_name>"
 *
 * Both the server (when building the system prompt) and the client (when
 * rendering chips) derive the citation lookup from the SAME loader output,
 * so the keys + their values are guaranteed to agree. The server injects
 * `_citation_lookup` into the CONTEXT JSON so the model sees the legal
 * keys + values it can cite; the client receives the same lookup via the
 * SSE `citations` frame at stream start.
 *
 * v1: customer-360 + customer-book scopes only. Other scopes return an
 * empty lookup — the model still produces prose, just without inline chips.
 */

import type { AiScope } from "./scopes";

export type CitationCategory =
  | "signal"
  | "metric"
  | "ticket"
  | "billing"
  | "comm"
  | "usage"
  | "count";

export interface CitationEntry {
  /** Short human label shown at the top of the popover. */
  label: string;
  /** Primary value the chip stands for (rendered prominently). */
  value: string;
  /** Optional supplementary key/value pairs surfaced below the value. */
  raw?: Record<string, string | number | null>;
  /** Category tag — used for chip color hint + popover heading. */
  category: CitationCategory;
}

export type CitationLookup = Record<string, CitationEntry>;

/** Build a canonical citation key. */
export function makeCitationKey(
  category: CitationCategory,
  identifier: string,
): string {
  return `${category}:${identifier}`;
}

/**
 * Regex matching `[cite:KEY]` inline markers in assistant text. Allows any
 * non-whitespace, non-`]` characters in the key — the categories + ids
 * defined above stay inside that alphabet. Exposed for the client renderer.
 *
 * NOTE: must use the `g` flag at the call site, but `g` regexes are
 * stateful, so we keep the source string + let callers compile fresh
 * instances per parse.
 */
export const CITATION_PATTERN_SOURCE = "\\[cite:([^\\]\\s]+)\\]";

/**
 * Regex matching `<confidence: NN% — reason1 / reason2 / ...>` inline
 * markers. Captures the percent (1-3 digits) + the trailing reason text.
 * The em-dash is the canonical separator but we tolerate a regular dash
 * (the model occasionally substitutes one).
 *
 * Example match:
 *   <confidence: 62% — 4 historic matches / M-1 missed payment>
 */
export const CONFIDENCE_PATTERN_SOURCE =
  "<confidence:\\s*(\\d{1,3})%\\s*[—-]\\s*([^>]+)>";

/* ────────────────────────────────────────────────────────────────
 * Loader-side builders
 *
 * Each builder takes the same per-scope loaded data the context-loader
 * already has in hand and emits a flat lookup. We do NOT round-trip the
 * full snapshot — only the rows the model can reasonably cite.
 * ──────────────────────────────────────────────────────────────── */

interface MinimalScored {
  entity_id: string;
  company: string | null;
  am_name: string | null;
  signals_v2?: {
    composite?: number | null;
    stoplight?: "RED" | "YELLOW" | "GREEN" | null;
    tier?: string | null;
    sig_we_silent?: number | null;
    sig_client_silent?: number | null;
    sig_response_drop?: number | null;
    sig_volume_collapse?: number | null;
    sig_usage?: number | null;
    sig_billing?: number | null;
    flag_performance?: boolean | null;
    flag_tickets?: boolean | null;
    reason_one_line?: string | null;
    trajectory_7d?: string | null;
  } | null;
  metrics?: {
    days_since_in?: number | null;
    days_since_out?: number | null;
    last_in_iso?: string | null;
    last_out_iso?: string | null;
    last_any_iso?: string | null;
    channels_used_30d?: string | string[] | null;
    channels_used_90d?: string | string[] | null;
    total_30d?: number | null;
    total_90d?: number | null;
  } | null;
}

function channelsToString(v: string | string[] | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : null;
  return v.length > 0 ? v : null;
}

interface MinimalTicket {
  identifier: string;
  title: string;
  state: string;
  customerName?: string | null;
  amName?: string | null;
  classification?: string | null;
  createdAt: string;
}

interface MinimalPerformance {
  predicted_6_month_leads?: number | null;
  review_target?: number | null;
  leads_total?: number | null;
  keywords_count?: number | null;
  keywords_top3?: number | null;
  keywords_top10?: number | null;
}

interface MinimalPostPayment {
  verdict?: string | null;
  needs_am_call?: boolean | null;
  verdict_one_line?: string | null;
}

const SUB_SCORE_LABELS: Record<string, string> = {
  we_silent: "We're silent",
  client_silent: "Client's silent",
  response_drop: "Response drop",
  volume_collapse: "Volume collapse",
  usage: "App usage drop",
  billing: "Billing pressure",
};

/**
 * Build a citation lookup for a single-customer (customer-360) scope.
 * The model sees one customer's full record; emit one entry per cite-able
 * datum it might mention.
 */
function buildCustomer360Lookup(args: {
  sc: MinimalScored | null;
  performance: MinimalPerformance | null;
  tickets: MinimalTicket[];
  postPayment: MinimalPostPayment | null;
}): CitationLookup {
  const { sc, performance, tickets, postPayment } = args;
  const out: CitationLookup = {};
  if (!sc) return out;
  const eid = sc.entity_id;

  // ── Composite + tier metrics ──
  if (typeof sc.signals_v2?.composite === "number") {
    out[makeCitationKey("metric", `composite_score:${eid}`)] = {
      category: "metric",
      label: "Composite score",
      value: String(sc.signals_v2.composite),
      raw: {
        stoplight: sc.signals_v2.stoplight ?? null,
        tier: sc.signals_v2.tier ?? null,
        trajectory_7d: sc.signals_v2.trajectory_7d ?? null,
      },
    };
  }

  // ── Sub-score signals (one entry per non-zero sub-score) ──
  const subScoreMap: Array<[string, number | null | undefined]> = [
    ["we_silent", sc.signals_v2?.sig_we_silent],
    ["client_silent", sc.signals_v2?.sig_client_silent],
    ["response_drop", sc.signals_v2?.sig_response_drop],
    ["volume_collapse", sc.signals_v2?.sig_volume_collapse],
    ["usage", sc.signals_v2?.sig_usage],
    ["billing", sc.signals_v2?.sig_billing],
  ];
  for (const [name, score] of subScoreMap) {
    if (typeof score !== "number" || score <= 0) continue;
    const label = SUB_SCORE_LABELS[name] ?? name;
    // Emit BOTH a "signal:<name>" key (for the qualitative claim — e.g.
    // citing "We're silent" as a contributing flag) AND a "metric:<name>"
    // key (for citing the numeric sub-score). They share the value but the
    // chip category drives the popover styling + heading.
    const valueText =
      name === "we_silent" && typeof sc.metrics?.days_since_out === "number"
        ? `${score} (${sc.metrics.days_since_out} days since last outbound)`
        : name === "client_silent" &&
            typeof sc.metrics?.days_since_in === "number"
          ? `${score} (${sc.metrics.days_since_in} days since last inbound)`
          : String(score);

    out[makeCitationKey("signal", `${name}:${eid}`)] = {
      category: "signal",
      label,
      value: valueText,
      raw: {
        sub_score: score,
        sub_score_name: name,
      },
    };
    out[makeCitationKey("metric", `sig_${name}:${eid}`)] = {
      category: "metric",
      label: `${label} sub-score`,
      value: String(score),
      raw: { sub_score_name: name },
    };
  }

  // ── Comms metrics ──
  if (typeof sc.metrics?.days_since_in === "number") {
    out[makeCitationKey("metric", `days_since_in:${eid}`)] = {
      category: "metric",
      label: "Days since inbound",
      value: `${sc.metrics.days_since_in} days`,
      raw: { last_in_iso: sc.metrics.last_in_iso ?? null },
    };
    out[makeCitationKey("comm", `last_inbound:${eid}`)] = {
      category: "comm",
      label: "Last inbound message",
      value: sc.metrics.last_in_iso
        ? `${sc.metrics.last_in_iso} (${sc.metrics.days_since_in} days ago)`
        : `${sc.metrics.days_since_in} days ago`,
      raw: { last_in_iso: sc.metrics.last_in_iso ?? null },
    };
  }
  if (typeof sc.metrics?.days_since_out === "number") {
    out[makeCitationKey("metric", `days_since_out:${eid}`)] = {
      category: "metric",
      label: "Days since outbound",
      value: `${sc.metrics.days_since_out} days`,
      raw: { last_out_iso: sc.metrics.last_out_iso ?? null },
    };
    out[makeCitationKey("comm", `last_outbound:${eid}`)] = {
      category: "comm",
      label: "Last outbound message",
      value: sc.metrics.last_out_iso
        ? `${sc.metrics.last_out_iso} (${sc.metrics.days_since_out} days ago)`
        : `${sc.metrics.days_since_out} days ago`,
      raw: { last_out_iso: sc.metrics.last_out_iso ?? null },
    };
  }
  if (typeof sc.metrics?.total_30d === "number") {
    out[makeCitationKey("metric", `comm_total_30d:${eid}`)] = {
      category: "metric",
      label: "Total comms (30d)",
      value: String(sc.metrics.total_30d),
      raw: {
        channels_used_30d: channelsToString(sc.metrics.channels_used_30d),
      },
    };
  }
  if (typeof sc.metrics?.total_90d === "number") {
    out[makeCitationKey("metric", `comm_total_90d:${eid}`)] = {
      category: "metric",
      label: "Total comms (90d)",
      value: String(sc.metrics.total_90d),
      raw: {
        channels_used_90d: channelsToString(sc.metrics.channels_used_90d),
      },
    };
  }

  // ── Performance metrics ──
  if (performance) {
    if (typeof performance.leads_total === "number") {
      out[makeCitationKey("metric", `leads_total:${eid}`)] = {
        category: "metric",
        label: "Total leads (YTD)",
        value: String(performance.leads_total),
      };
    }
    if (typeof performance.predicted_6_month_leads === "number") {
      out[makeCitationKey("metric", `predicted_6mo_leads:${eid}`)] = {
        category: "metric",
        label: "Predicted 6-month leads",
        value: String(performance.predicted_6_month_leads),
      };
    }
    if (typeof performance.review_target === "number") {
      out[makeCitationKey("metric", `review_target:${eid}`)] = {
        category: "metric",
        label: "Weekly review target",
        value: String(performance.review_target),
      };
    }
    if (typeof performance.keywords_count === "number") {
      out[makeCitationKey("metric", `keyword_count:${eid}`)] = {
        category: "metric",
        label: "Tracked keywords",
        value: String(performance.keywords_count),
        raw: {
          top3: performance.keywords_top3 ?? null,
          top10: performance.keywords_top10 ?? null,
        },
      };
    }
  }

  // ── Tickets ──
  for (const t of tickets.slice(0, 8)) {
    out[makeCitationKey("ticket", t.identifier)] = {
      category: "ticket",
      label: t.identifier,
      value: t.title,
      raw: {
        state: t.state,
        classification: t.classification ?? null,
        created_at: t.createdAt,
      },
    };
  }

  // ── Post-payment verdict ──
  if (postPayment?.verdict) {
    out[makeCitationKey("billing", `post_payment_verdict:${eid}`)] = {
      category: "billing",
      label: "Post-payment verdict",
      value: postPayment.verdict,
      raw: {
        verdict_one_line: postPayment.verdict_one_line ?? null,
        needs_am_call:
          postPayment.needs_am_call === true
            ? "yes"
            : postPayment.needs_am_call === false
              ? "no"
              : null,
      },
    };
  }

  return out;
}

/**
 * Build a citation lookup for a multi-customer (customer-book) scope. The
 * model sees aggregate counts + a list of top-at-risk customers; emit
 * entries for the counts + per-customer composite/reason for the surfaced
 * rows. We deliberately skip the deep per-customer sub-scores here — the
 * book context doesn't carry them in the blob, so we'd be lying about
 * what's cite-able.
 */
function buildCustomerBookLookup(args: {
  counts: {
    total: number;
    red: number;
    yellow: number;
    green: number;
  };
  trajectory: { worsening: number; improving: number };
  health: {
    median_composite: number | null;
    outbound_silence_14d: number;
    outbound_silence_30d: number;
  };
  topAtRisk: Array<{
    entity_id: string;
    company: string | null;
    composite: number | null;
    stoplight: string | null;
    reason: string | null;
    days_since_in: number | null;
    days_since_out: number | null;
  }>;
}): CitationLookup {
  const { counts, trajectory, health, topAtRisk } = args;
  const out: CitationLookup = {};

  // Book-level counts.
  out[makeCitationKey("count", "red_customers")] = {
    category: "count",
    label: "RED customers",
    value: String(counts.red),
    raw: { total: counts.total },
  };
  out[makeCitationKey("count", "yellow_customers")] = {
    category: "count",
    label: "YELLOW customers",
    value: String(counts.yellow),
    raw: { total: counts.total },
  };
  out[makeCitationKey("count", "green_customers")] = {
    category: "count",
    label: "GREEN customers",
    value: String(counts.green),
    raw: { total: counts.total },
  };
  out[makeCitationKey("count", "total_customers")] = {
    category: "count",
    label: "Total active customers",
    value: String(counts.total),
  };
  out[makeCitationKey("count", "worsening_7d")] = {
    category: "count",
    label: "Worsening (7d)",
    value: String(trajectory.worsening),
  };
  out[makeCitationKey("count", "improving_7d")] = {
    category: "count",
    label: "Improving (7d)",
    value: String(trajectory.improving),
  };
  out[makeCitationKey("count", "outbound_silence_14d")] = {
    category: "count",
    label: "Silent ≥14 days (outbound)",
    value: String(health.outbound_silence_14d),
  };
  out[makeCitationKey("count", "outbound_silence_30d")] = {
    category: "count",
    label: "Silent ≥30 days (outbound)",
    value: String(health.outbound_silence_30d),
  };
  if (health.median_composite !== null) {
    out[makeCitationKey("metric", "median_composite_book")] = {
      category: "metric",
      label: "Median composite (book)",
      value: String(health.median_composite),
    };
  }

  // Top at-risk surface: composite + reason per row.
  for (const c of topAtRisk) {
    if (typeof c.composite === "number") {
      out[makeCitationKey("metric", `composite_score:${c.entity_id}`)] = {
        category: "metric",
        label: `Composite — ${c.company ?? c.entity_id}`,
        value: String(c.composite),
        raw: {
          stoplight: c.stoplight ?? null,
          biz_name: c.company ?? null,
          reason: c.reason ?? null,
        },
      };
    }
    if (typeof c.days_since_out === "number") {
      out[makeCitationKey("metric", `days_since_out:${c.entity_id}`)] = {
        category: "metric",
        label: `Days since outbound — ${c.company ?? c.entity_id}`,
        value: `${c.days_since_out} days`,
      };
    }
    if (typeof c.days_since_in === "number") {
      out[makeCitationKey("metric", `days_since_in:${c.entity_id}`)] = {
        category: "metric",
        label: `Days since inbound — ${c.company ?? c.entity_id}`,
        value: `${c.days_since_in} days`,
      };
    }
    if (c.reason) {
      out[makeCitationKey("signal", `reason:${c.entity_id}`)] = {
        category: "signal",
        label: `Top signal — ${c.company ?? c.entity_id}`,
        value: c.reason,
      };
    }
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────
 * Scope dispatcher
 * ──────────────────────────────────────────────────────────────── */

export interface Customer360CitationInput {
  kind: "customer-360";
  sc: MinimalScored | null;
  performance: MinimalPerformance | null;
  tickets: MinimalTicket[];
  postPayment: MinimalPostPayment | null;
}

export interface CustomerBookCitationInput {
  kind: "customer-book";
  counts: { total: number; red: number; yellow: number; green: number };
  trajectory: { worsening: number; improving: number };
  health: {
    median_composite: number | null;
    outbound_silence_14d: number;
    outbound_silence_30d: number;
  };
  topAtRisk: Array<{
    entity_id: string;
    company: string | null;
    composite: number | null;
    stoplight: string | null;
    reason: string | null;
    days_since_in: number | null;
    days_since_out: number | null;
  }>;
}

export type CitationLookupInput =
  | Customer360CitationInput
  | CustomerBookCitationInput;

/**
 * Build a citation lookup for any supported scope. Unsupported scopes
 * return an empty object (model will emit no chips for those surfaces in
 * v1).
 */
export function buildCitationLookup(input: CitationLookupInput): CitationLookup {
  switch (input.kind) {
    case "customer-360":
      return buildCustomer360Lookup({
        sc: input.sc,
        performance: input.performance,
        tickets: input.tickets,
        postPayment: input.postPayment,
      });
    case "customer-book":
      return buildCustomerBookLookup({
        counts: input.counts,
        trajectory: input.trajectory,
        health: input.health,
        topAtRisk: input.topAtRisk,
      });
  }
}

/**
 * Return whether the given scope has citation support in v1. The ask route
 * checks this before emitting the `citations` SSE frame; scopes without
 * support send an empty lookup, which is cheaper than computing one.
 */
export function scopeHasCitationSupport(scope: AiScope): boolean {
  return scope.kind === "customer-360" || scope.kind === "customer-book";
}
