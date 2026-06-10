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
 * Phase E-18 (Haiku comms perspective) adds three new comm-flavored shapes
 * the model can reference, all under the existing `comm` category so
 * client-side popover styling is consistent:
 *   - comm:sentiment:<entity_id>           — warm/neutral/tense/escalating
 *   - comm:topic:<slug>:<entity_id>        — one per perspective topic
 *   - comm:substance:<entity_id>           — 0-100 substance score
 *
 * Both the server (when building the system prompt) and the client (when
 * rendering chips) derive the citation lookup from the SAME loader output,
 * so the keys + their values are guaranteed to agree. The server injects
 * `_citation_lookup` into the CONTEXT JSON so the model sees the legal
 * keys + values it can cite; the client receives the same lookup via the
 * SSE `citations` frame at stream start.
 *
 * v3a.2 (Phase E-17 Wave 3a.1): all 8 scopes now build a citation lookup —
 * inbox, customer-360, customer-book, performance-landing, performance-report,
 * escalation-overview, post-payment-book, post-payment-customer. The model
 * still emits no chips on `hidden` (no surface-data context).
 */

import type { AiScope } from "./scopes";

export type CitationCategory =
  | "signal"
  | "metric"
  | "ticket"
  | "billing"
  | "comm"
  | "usage"
  | "count"
  // Phase G — Beacon AI Knowledge Base. KB chips link to a doc in
  // beacon_ai_docs. id = the doc's slug. The popover shows title +
  // section + excerpt; clicking opens /admin/knowledge/<doc_id>.
  | "kb"
  // Roadmap-v2-4 — Keeper fact citation. id = "<fact_id>" or
  // "<fact_id>:<entity_id>" when scope needs disambiguation. The chip
  // popover surfaces the fact's topic/field/value plus the hybrid
  // retrieval "why" trace (matched_via / RRF / rerank) when provenance
  // is attached.
  | "fact";

/**
 * Roadmap-v2-4 — "why" trace for citation chips backed by hybrid Keeper
 * retrieval. When present, the chip's popover renders an inline trace card
 * showing which retrieval stages surfaced this fact (embedding / keyword),
 * the merged RRF score, the Voyage rerank relevance, and the fact's
 * position in the candidate pool.
 *
 * Only Keeper-backed chips (read_customer_brain / query_brain hybrid mode)
 * carry this. Chips sourced from snapshot rows, KB docs, or other
 * non-Keeper paths leave it undefined → the popover falls back to the
 * existing "source" line without the rerank UI.
 */
export interface CitationProvenance {
  /** Which retrieval stages surfaced this fact. */
  matched_via: Array<"embedding" | "keyword">;
  /** Sum of reciprocal ranks across signals from the RRF merge. */
  rrf_score: number;
  /** Voyage rerank-2.5-lite relevance score, 0-1. Null when rerank skipped/failed. */
  rerank_score: number | null;
  /** 1-indexed position in the final ranked output (1 = top). */
  rank: number;
  /** Number of candidates considered after the RRF merge. */
  candidate_pool_size: number;
  /** Optional original question that drove the retrieval. */
  query?: string | null;
}

export interface CitationEntry {
  /** Short human label shown at the top of the popover. */
  label: string;
  /** Primary value the chip stands for (rendered prominently). */
  value: string;
  /** Optional supplementary key/value pairs surfaced below the value. */
  raw?: Record<string, string | number | null>;
  /** Category tag — used for chip color hint + popover heading. */
  category: CitationCategory;
  /**
   * Optional Wave-1 hybrid-retrieval provenance. Drives the inline trace
   * card in CitationChip. Backwards-compatible: older response payloads
   * without this field still render the original popover untouched.
   */
  provenance?: CitationProvenance;
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

/**
 * Phase G — Knowledge Base citation builder. Knowledge chunks layer on
 * TOP of any scope's discriminated-union lookup; they're additive, not
 * mutually exclusive. Each chunk surfaces as a kb:<slug> entry the
 * model can cite when it draws on the doc.
 *
 * Caller pattern in context loaders:
 *   const baseCitations = buildCitationLookup({ kind: "...", ... });
 *   const kbChunks = await searchDocs(question, scope);
 *   const kbCitations = buildKnowledgeCitations(kbChunks);
 *   const citationLookup = { ...baseCitations, ...kbCitations };
 */
export function buildKnowledgeCitations(
  chunks: Array<{
    slug: string;
    title: string;
    section: string | null;
    excerpt: string;
  }>,
): CitationLookup {
  const out: CitationLookup = {};
  for (const c of chunks) {
    if (!c.slug) continue;
    out[makeCitationKey("kb", c.slug)] = {
      category: "kb",
      label: c.title,
      value: c.section ? `${c.title} · ${c.section}` : c.title,
      raw: {
        slug: c.slug,
        section: c.section,
        excerpt: c.excerpt.slice(0, 240),
      },
    };
  }
  return out;
}

/**
 * Roadmap-v2-4 — Build a citation lookup for Keeper facts surfaced by the
 * Wave-1 hybrid retrieval pipeline. Each fact becomes a `fact:<fact_id>`
 * entry carrying provenance — matched_via badges, RRF score, rerank score,
 * rank, candidate pool size. The chip popover renders this as an inline
 * trace card so the AM can see WHY a fact was surfaced.
 *
 * Call this from the client after a `read_customer_brain` (hybrid) or
 * `query_brain` (hybrid) tool execution, and pass the resulting lookup as
 * `extra_citations` on the continuation `ask` request — same plumbing as
 * `query_customer_book` Tier 4.
 */
export function buildBrainProvenanceCitations(args: {
  facts: Array<{
    fact_id: string;
    topic_category?: string | null;
    topic_subcategory?: string | null;
    field_name?: string | null;
    value: string;
    matched_via: Array<"embedding" | "keyword">;
    rrf_score: number;
    /** Voyage rerank-2.5-lite score, 0-1. May be null when rerank skipped. */
    relevance_score: number | null;
    confirmed_at?: string | null;
    source_type?: string | null;
  }>;
  candidatePoolSize: number;
  query?: string | null;
}): CitationLookup {
  const out: CitationLookup = {};
  const { facts, candidatePoolSize, query } = args;
  facts.forEach((f, idx) => {
    if (!f.fact_id) return;
    const subPath = f.topic_subcategory
      ? `${f.topic_category ?? "fact"}/${f.topic_subcategory}${f.field_name ? `/${f.field_name}` : ""}`
      : "Keeper fact";
    out[makeCitationKey("fact", f.fact_id)] = {
      category: "fact",
      label: subPath,
      value: f.value,
      raw: {
        topic_category: f.topic_category ?? null,
        topic_subcategory: f.topic_subcategory ?? null,
        field_name: f.field_name ?? null,
        source_type: f.source_type ?? null,
        confirmed_at: f.confirmed_at ?? null,
      },
      provenance: {
        matched_via: f.matched_via,
        rrf_score: f.rrf_score,
        rerank_score: f.relevance_score,
        rank: idx + 1,
        candidate_pool_size: candidatePoolSize,
        query: query ?? null,
      },
    };
  });
  return out;
}

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

/* ────────────────────────────────────────────────────────────────
 * Phase E-18 — comms perspective citation helpers.
 *
 * The shape that lands here is the LIGHT subset of the perspective
 * (sentiment, topics, substance_score, initiator_pattern, response_latency)
 * — the same subset hydrated onto ScoredCustomerV2.comms_perspective.
 * The full row (haiku_summary, conversation_arcs, sentiment_evidence)
 * lives behind /api/customer/perspective and isn't surfaced via citation.
 * ──────────────────────────────────────────────────────────────── */

export interface CommsPerspectiveCitationData {
  sentiment: "warm" | "neutral" | "tense" | "escalating";
  topics: string[];
  substance_score: number;
  initiator_pattern: "mostly_us" | "mostly_them" | "balanced";
  response_latency_hours: number | null;
}

function topicSlug(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

/**
 * Emit comm:sentiment, comm:topic:*, comm:substance entries for a single
 * entity. The bizname suffix on labels makes the popover scannable when
 * cited inside a multi-customer scope (inbox, book).
 *
 * Returns an empty object when `perspective` is null/undefined — caller
 * can safely spread `{...buildCommsPerspectiveCitations(...)}` without an
 * existence check.
 */
export function buildCommsPerspectiveCitations(args: {
  entityId: string;
  bizName: string | null;
  perspective: CommsPerspectiveCitationData | null | undefined;
}): CitationLookup {
  const out: CitationLookup = {};
  const p = args.perspective;
  if (!p) return out;
  const eid = args.entityId;
  const suffix = args.bizName ? ` — ${args.bizName}` : "";

  out[makeCitationKey("comm", `sentiment:${eid}`)] = {
    category: "comm",
    label: `Comms sentiment${suffix}`,
    value: p.sentiment,
    raw: {
      initiator_pattern: p.initiator_pattern,
      response_latency_hours: p.response_latency_hours,
    },
  };

  out[makeCitationKey("comm", `substance:${eid}`)] = {
    category: "comm",
    label: `Comms substance${suffix}`,
    value: `${p.substance_score}/100`,
    raw: { substance_score: p.substance_score },
  };

  for (const t of p.topics.slice(0, 5)) {
    const slug = topicSlug(t);
    if (!slug) continue;
    out[makeCitationKey("comm", `topic:${slug}:${eid}`)] = {
      category: "comm",
      label: `Topic${suffix}`,
      value: t,
      raw: { topic_raw: t },
    };
  }

  return out;
}

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
  silenceByAm?: Array<{
    am_name: string;
    total_customers: number;
    silent_30d_plus: number;
    silent_60d_plus: number;
    silent_90d_plus: number;
    silent_120d_plus: number;
  }>;
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
  const { counts, trajectory, health, silenceByAm, topAtRisk } = args;
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

  // F-polish-AI-T1 — per-AM silence rows. One citation entry per AM, per
  // threshold. Slug the am_name into a lookup key (spaces → underscores,
  // lowercased) so `[cite:count:silence_by_am:30d:sakshi_mamgain]` is the
  // canonical chip id.
  if (silenceByAm && silenceByAm.length > 0) {
    for (const row of silenceByAm) {
      const slug = row.am_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const thresholdRows = [
        { threshold: 30 as const, count: row.silent_30d_plus, label: "≥30d" },
        { threshold: 60 as const, count: row.silent_60d_plus, label: "≥60d" },
        { threshold: 90 as const, count: row.silent_90d_plus, label: "≥90d" },
        { threshold: 120 as const, count: row.silent_120d_plus, label: "≥120d" },
      ];
      for (const r of thresholdRows) {
        out[makeCitationKey("count", `silence_by_am:${r.threshold}d:${slug}`)] = {
          category: "count",
          label: `${row.am_name} — silent ${r.label} (outbound)`,
          value: String(r.count),
          raw: {
            am_name: row.am_name,
            threshold_days: r.threshold,
            total_customers: row.total_customers,
          },
        };
      }
      out[makeCitationKey("count", `silence_by_am:total:${slug}`)] = {
        category: "count",
        label: `${row.am_name} — total customers`,
        value: String(row.total_customers),
        raw: { am_name: row.am_name },
      };
    }
  }

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
 * v3a.2 — additional scope builders (inbox / performance-landing /
 * performance-report / escalation-overview / post-payment-book /
 * post-payment-customer). Each follows the same shape as customer-360
 * (per-entity entries keyed by entity/customer id + aggregate counts
 * without a suffix).
 * ──────────────────────────────────────────────────────────────── */

interface InboxCustomer {
  entity_id: string;
  company: string | null;
  am_name?: string | null;
  composite: number | null;
  stoplight: string | null;
  reason?: string | null;
  days_since_in?: number | null;
  days_since_out?: number | null;
  /** Optional sub-scores. Used to pick the dominant signal per customer. */
  sub_scores?: {
    we_silent?: number | null;
    client_silent?: number | null;
    response_drop?: number | null;
    volume_collapse?: number | null;
    usage?: number | null;
    billing?: number | null;
  } | null;
}

interface InboxOpenTicket {
  identifier: string;
  title: string;
  classification: string | null;
  state: string;
  customer?: string | null;
  am?: string | null;
  created_at: string;
}

function ageDays(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function pickDominantSignal(
  sub: InboxCustomer["sub_scores"],
): { name: string; score: number } | null {
  if (!sub) return null;
  const entries: Array<[string, number | null | undefined]> = [
    ["we_silent", sub.we_silent],
    ["client_silent", sub.client_silent],
    ["response_drop", sub.response_drop],
    ["volume_collapse", sub.volume_collapse],
    ["usage", sub.usage],
    ["billing", sub.billing],
  ];
  let best: { name: string; score: number } | null = null;
  for (const [name, score] of entries) {
    if (typeof score !== "number" || score <= 0) continue;
    if (best === null || score > best.score) {
      best = { name, score };
    }
  }
  return best;
}

function buildInboxLookup(args: {
  counts: {
    critical: number;
    watching: number;
    needs_am_call: number;
    open_tickets: number;
  };
  critical: InboxCustomer[];
  watching: InboxCustomer[];
  openTickets: InboxOpenTicket[];
}): CitationLookup {
  const out: CitationLookup = {};

  // Aggregate counts (no entity suffix).
  out[makeCitationKey("count", "critical_count")] = {
    category: "count",
    label: "Critical customers in inbox",
    value: String(args.counts.critical),
  };
  out[makeCitationKey("count", "watching_count")] = {
    category: "count",
    label: "Watching customers in inbox",
    value: String(args.counts.watching),
  };
  out[makeCitationKey("count", "needs_am_call_count")] = {
    category: "count",
    label: "Post-payment needs AM call",
    value: String(args.counts.needs_am_call),
  };
  out[makeCitationKey("count", "open_tickets_total")] = {
    category: "count",
    label: "Open tickets in inbox",
    value: String(args.counts.open_tickets),
  };

  // Per-customer entries — critical + watching share the same shape.
  const surfaced = [...args.critical, ...args.watching];
  for (const c of surfaced) {
    const eid = c.entity_id;
    if (typeof c.composite === "number") {
      out[makeCitationKey("metric", `composite_score:${eid}`)] = {
        category: "metric",
        label: `Composite — ${c.company ?? eid}`,
        value: c.stoplight
          ? `${c.composite}, ${c.stoplight}`
          : String(c.composite),
        raw: {
          stoplight: c.stoplight ?? null,
          biz_name: c.company ?? null,
          am_name: c.am_name ?? null,
        },
      };
    }
    if (typeof c.days_since_out === "number") {
      out[makeCitationKey("metric", `days_since_out:${eid}`)] = {
        category: "metric",
        label: `Days since outbound — ${c.company ?? eid}`,
        value: `${c.days_since_out} days`,
      };
    }
    if (typeof c.days_since_in === "number") {
      out[makeCitationKey("metric", `days_since_in:${eid}`)] = {
        category: "metric",
        label: `Days since inbound — ${c.company ?? eid}`,
        value: `${c.days_since_in} days`,
      };
    }
    // Dominant signal (per the spec — only emit when we can identify one).
    const dom = pickDominantSignal(c.sub_scores ?? null);
    if (dom) {
      const label = SUB_SCORE_LABELS[dom.name] ?? dom.name;
      out[makeCitationKey("signal", `${dom.name}:${eid}`)] = {
        category: "signal",
        label: `${label} — ${c.company ?? eid}`,
        value: String(dom.score),
        raw: {
          sub_score: dom.score,
          sub_score_name: dom.name,
          reason: c.reason ?? null,
        },
      };
    } else if (c.reason) {
      // Fallback: use the reason_one_line as a generic signal anchor.
      out[makeCitationKey("signal", `reason:${eid}`)] = {
        category: "signal",
        label: `Top signal — ${c.company ?? eid}`,
        value: c.reason,
      };
    }
  }

  // Open ticket entries.
  for (const t of args.openTickets) {
    if (!t.identifier) continue;
    const age = ageDays(t.created_at);
    out[makeCitationKey("ticket", t.identifier)] = {
      category: "ticket",
      label: t.identifier,
      value: t.title,
      raw: {
        classification: t.classification ?? null,
        state: t.state,
        age_days: age,
        customer: t.customer ?? null,
        am: t.am ?? null,
      },
    };
  }

  return out;
}

function buildPerformanceLandingLookup(args: {
  total_active_customers: number;
  reports_generated_this_week: number | null;
  median_composite_score: number | null;
}): CitationLookup {
  const out: CitationLookup = {};
  out[makeCitationKey("count", "total_active_customers")] = {
    category: "count",
    label: "Total active customers",
    value: String(args.total_active_customers),
  };
  if (args.reports_generated_this_week !== null) {
    out[makeCitationKey("count", "reports_generated_this_week")] = {
      category: "count",
      label: "Reports generated this week",
      value: String(args.reports_generated_this_week),
    };
  }
  if (args.median_composite_score !== null) {
    out[makeCitationKey("metric", "median_composite_score")] = {
      category: "metric",
      label: "Median composite (book)",
      value: String(args.median_composite_score),
    };
  }
  return out;
}

interface PerformanceReportCitationInputData {
  entity_id: string;
  ytd_leads: number | null;
  predicted_6_month_leads: number | null;
  gbp_clicks_current: { month: string; clicks: number } | null;
  gbp_clicks_peak: { month: string; clicks: number } | null;
  /** Percent dip from peak → current (negative = drop). Pre-computed by loader. */
  gbp_dip_pct: number | null;
  active_keyword_rankings: number;
  top_keywords: Array<{ keyword: string; rank: number | null }>;
  review_target: number | null;
  /** Reviews data — loader returns null when not surfaced. */
  reviews_total: number | null;
  reviews_avg_rating: number | null;
}

function keywordSlug(keyword: string): string {
  return keyword
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function buildPerformanceReportLookup(
  d: PerformanceReportCitationInputData,
): CitationLookup {
  const out: CitationLookup = {};
  const eid = d.entity_id;
  if (typeof d.ytd_leads === "number") {
    out[makeCitationKey("metric", `ytd_leads:${eid}`)] = {
      category: "metric",
      label: "YTD leads",
      value: String(d.ytd_leads),
    };
  }
  if (typeof d.predicted_6_month_leads === "number") {
    out[makeCitationKey("metric", `predicted_6_month_leads:${eid}`)] = {
      category: "metric",
      label: "Predicted 6-month leads",
      value: String(d.predicted_6_month_leads),
    };
  }
  if (d.gbp_clicks_current) {
    out[makeCitationKey("metric", `gbp_clicks_current:${eid}`)] = {
      category: "metric",
      label: "GBP clicks (current month)",
      value: `${d.gbp_clicks_current.clicks} (${d.gbp_clicks_current.month})`,
      raw: {
        month: d.gbp_clicks_current.month,
        clicks: d.gbp_clicks_current.clicks,
      },
    };
  }
  if (d.gbp_clicks_peak) {
    out[makeCitationKey("metric", `gbp_clicks_peak:${eid}`)] = {
      category: "metric",
      label: "GBP clicks (peak month)",
      value: `${d.gbp_clicks_peak.clicks} (${d.gbp_clicks_peak.month})`,
      raw: {
        month: d.gbp_clicks_peak.month,
        clicks: d.gbp_clicks_peak.clicks,
      },
    };
  }
  if (typeof d.gbp_dip_pct === "number") {
    out[makeCitationKey("metric", `gbp_dip_pct:${eid}`)] = {
      category: "metric",
      label: "GBP click dip vs peak",
      value: `${d.gbp_dip_pct.toFixed(1)}%`,
      raw: {
        peak_month: d.gbp_clicks_peak?.month ?? null,
        current_month: d.gbp_clicks_current?.month ?? null,
      },
    };
  }
  out[makeCitationKey("count", `active_keyword_rankings:${eid}`)] = {
    category: "count",
    label: "Active keyword rankings",
    value: String(d.active_keyword_rankings),
  };
  if (d.top_keywords.length > 0) {
    const top = d.top_keywords[0];
    if (top && typeof top.rank === "number") {
      out[makeCitationKey("metric", `top_keyword_rank:${eid}`)] = {
        category: "metric",
        label: "Top keyword rank",
        value: `#${top.rank} — "${top.keyword}"`,
        raw: { keyword: top.keyword, rank: top.rank },
      };
    }
  }
  if (typeof d.review_target === "number") {
    out[makeCitationKey("metric", `review_target:${eid}`)] = {
      category: "metric",
      label: "Weekly review target",
      value: String(d.review_target),
    };
  }
  if (typeof d.reviews_total === "number") {
    out[makeCitationKey("metric", `reviews_total:${eid}`)] = {
      category: "metric",
      label: "Total reviews",
      value: String(d.reviews_total),
    };
  }
  if (typeof d.reviews_avg_rating === "number") {
    out[makeCitationKey("metric", `reviews_avg_rating:${eid}`)] = {
      category: "metric",
      label: "Avg review rating",
      value: d.reviews_avg_rating.toFixed(2),
    };
  }
  // Per-keyword rank entries (top 3).
  for (const k of d.top_keywords.slice(0, 3)) {
    if (typeof k.rank !== "number") continue;
    const slug = keywordSlug(k.keyword);
    if (!slug) continue;
    out[makeCitationKey("metric", `keyword_rank:${slug}:${eid}`)] = {
      category: "metric",
      label: `Rank — "${k.keyword}"`,
      value: `#${k.rank}`,
      raw: { keyword: k.keyword, rank: k.rank },
    };
  }
  return out;
}

interface EscalationTicketCitationInput {
  identifier: string;
  title: string;
  classification: string | null;
  state: string;
  customer: string | null;
  am: string | null;
  created_at: string;
  age_days: number | null;
}

function buildEscalationOverviewLookup(args: {
  tickets: EscalationTicketCitationInput[];
  open_total: number;
  by_am: Record<string, number>;
  by_classification: Record<string, number>;
  aged_14d_plus: number;
  aged_30d_plus: number;
}): CitationLookup {
  const out: CitationLookup = {};

  out[makeCitationKey("count", "open_tickets_total")] = {
    category: "count",
    label: "Open tickets",
    value: String(args.open_total),
  };
  out[makeCitationKey("count", "tickets_aged_14d_plus")] = {
    category: "count",
    label: "Open tickets aged 14d+",
    value: String(args.aged_14d_plus),
  };
  out[makeCitationKey("count", "tickets_aged_30d_plus")] = {
    category: "count",
    label: "Open tickets aged 30d+",
    value: String(args.aged_30d_plus),
  };

  for (const [am, n] of Object.entries(args.by_am)) {
    if (!am) continue;
    out[makeCitationKey("count", `tickets_by_am:${am}`)] = {
      category: "count",
      label: `Open tickets — ${am}`,
      value: String(n),
      raw: { am_name: am },
    };
  }
  for (const [cls, n] of Object.entries(args.by_classification)) {
    if (!cls) continue;
    out[makeCitationKey("count", `tickets_by_classification:${cls}`)] = {
      category: "count",
      label: `${cls} tickets`,
      value: String(n),
      raw: { classification: cls },
    };
  }

  for (const t of args.tickets) {
    if (!t.identifier) continue;
    out[makeCitationKey("ticket", t.identifier)] = {
      category: "ticket",
      label: t.identifier,
      value: t.title,
      raw: {
        classification: t.classification ?? null,
        state: t.state,
        age_days: t.age_days,
        customer: t.customer ?? null,
        am: t.am ?? null,
      },
    };
  }

  return out;
}

interface PostPaymentBookCitationCustomer {
  cb_customer_id: string;
  biz_name: string | null;
  verdict: string | null;
  plan: string | null;
  first_payment_amount_cents: number | null;
}

function formatCents(cents: number | null): string {
  if (cents === null) return "—";
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

const VERDICT_DISPLAY: Record<string, string> = {
  icp: "ICP",
  review: "Review",
  not_icp: "Not ICP",
};

function displayVerdict(v: string | null): string {
  if (!v) return "—";
  return VERDICT_DISPLAY[v] ?? v;
}

function buildPostPaymentBookLookup(args: {
  counts: {
    icp: number;
    review: number;
    not_icp: number;
    needs_am_call: number;
  };
  customers: PostPaymentBookCitationCustomer[];
}): CitationLookup {
  const out: CitationLookup = {};
  out[makeCitationKey("count", "icp_verdict")] = {
    category: "count",
    label: "ICP verdicts",
    value: String(args.counts.icp),
  };
  out[makeCitationKey("count", "review_verdict")] = {
    category: "count",
    label: "Review verdicts",
    value: String(args.counts.review),
  };
  out[makeCitationKey("count", "not_icp_verdict")] = {
    category: "count",
    label: "Not ICP verdicts",
    value: String(args.counts.not_icp),
  };
  out[makeCitationKey("count", "needs_am_call_count")] = {
    category: "count",
    label: "Needs AM call",
    value: String(args.counts.needs_am_call),
  };

  for (const c of args.customers) {
    const id = c.cb_customer_id;
    if (!id) continue;
    if (c.verdict !== null) {
      out[makeCitationKey("metric", `verdict:${id}`)] = {
        category: "metric",
        label: `Verdict — ${c.biz_name ?? id}`,
        value: displayVerdict(c.verdict),
        raw: { cb_customer_id: id, biz_name: c.biz_name ?? null },
      };
    }
    if (c.plan) {
      out[makeCitationKey("billing", `plan:${id}`)] = {
        category: "billing",
        label: `Plan — ${c.biz_name ?? id}`,
        value: c.plan,
      };
    }
    if (typeof c.first_payment_amount_cents === "number") {
      out[makeCitationKey("billing", `first_payment_amount:${id}`)] = {
        category: "billing",
        label: `First payment — ${c.biz_name ?? id}`,
        value: formatCents(c.first_payment_amount_cents),
        raw: {
          amount_cents: c.first_payment_amount_cents,
        },
      };
    }
  }
  return out;
}

interface PostPaymentCustomerCitationInput {
  cb_customer_id: string;
  biz_name: string | null;
  verdict: string | null;
  verdict_one_line: string | null;
  plan: string | null;
  first_payment_amount_cents: number | null;
  key_flags: string[] | null;
}

function flagKey(flag: string): string {
  return flag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function buildPostPaymentCustomerLookup(
  d: PostPaymentCustomerCitationInput,
): CitationLookup {
  const out: CitationLookup = {};
  const id = d.cb_customer_id;
  if (!id) return out;
  if (d.verdict !== null) {
    out[makeCitationKey("metric", `verdict:${id}`)] = {
      category: "metric",
      label: "Verdict",
      value: displayVerdict(d.verdict),
      raw: { biz_name: d.biz_name ?? null },
    };
  }
  if (d.verdict_one_line) {
    out[makeCitationKey("metric", `verdict_one_line:${id}`)] = {
      category: "metric",
      label: "Verdict summary",
      value: d.verdict_one_line,
    };
  }
  if (d.plan) {
    out[makeCitationKey("billing", `plan:${id}`)] = {
      category: "billing",
      label: "Plan",
      value: d.plan,
    };
  }
  if (typeof d.first_payment_amount_cents === "number") {
    out[makeCitationKey("billing", `first_payment_amount:${id}`)] = {
      category: "billing",
      label: "First payment",
      value: formatCents(d.first_payment_amount_cents),
      raw: { amount_cents: d.first_payment_amount_cents },
    };
  }
  if (Array.isArray(d.key_flags)) {
    for (const flag of d.key_flags) {
      if (!flag) continue;
      const slug = flagKey(flag);
      if (!slug) continue;
      out[makeCitationKey("signal", `${slug}:${id}`)] = {
        category: "signal",
        label: "ICP flag",
        value: flag,
        raw: { flag_raw: flag },
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
  // F-polish-AI-T1 — per-AM outbound silence at 30/60/90/120d. Optional so
  // existing callers that don't pass it stay valid; the loader always
  // populates it today.
  silenceByAm?: Array<{
    am_name: string;
    total_customers: number;
    silent_30d_plus: number;
    silent_60d_plus: number;
    silent_90d_plus: number;
    silent_120d_plus: number;
  }>;
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

export interface InboxCitationInput {
  kind: "inbox";
  counts: {
    critical: number;
    watching: number;
    needs_am_call: number;
    open_tickets: number;
  };
  critical: InboxCustomer[];
  watching: InboxCustomer[];
  openTickets: InboxOpenTicket[];
}

export interface PerformanceLandingCitationInput {
  kind: "performance-landing";
  total_active_customers: number;
  reports_generated_this_week: number | null;
  median_composite_score: number | null;
}

export interface PerformanceReportCitationInput
  extends PerformanceReportCitationInputData {
  kind: "performance-report";
}

export interface EscalationOverviewCitationInput {
  kind: "escalation-overview";
  tickets: EscalationTicketCitationInput[];
  open_total: number;
  by_am: Record<string, number>;
  by_classification: Record<string, number>;
  aged_14d_plus: number;
  aged_30d_plus: number;
}

export interface PostPaymentBookCitationInput {
  kind: "post-payment-book";
  counts: {
    icp: number;
    review: number;
    not_icp: number;
    needs_am_call: number;
  };
  customers: PostPaymentBookCitationCustomer[];
}

export interface PostPaymentCustomerCitationInputWrap
  extends PostPaymentCustomerCitationInput {
  kind: "post-payment-customer";
}

// Phase F-polish-AI — Miss Payment Beacon citations.
// Categories used:
//   count — per-AM rollup counts + KPI totals
//   billing — per-invoice rows (invoice_number is the natural key)
// The biz_name / amount / am stays under raw so the popover renders a
// useful tooltip even on bare count chips.
export interface MissPaymentOverviewCitationInput {
  kind: "miss-payment-overview";
  totals: {
    total_balance: number;
    invoice_count: number;
    unique_customers: number;
    ach_in_flight: number;
    multi_month_count: number;
    auto_debit_off_balance: number;
    recovery_coverage_pct: number;
  };
  by_am: Array<{
    am_name: string;
    balance: number;
    invoice_count: number;
    customer_count: number;
  }>;
  top_rows: Array<{
    invoice_number: string;
    biz_name: string;
    am_name: string;
    amount_due: number;
    invoice_date: string;
    auto_debit: string;
    ach_status: string;
    status: string;
    ticket_id: string | null;
  }>;
  multi_month: Array<{
    key: string;
    biz_name: string;
    am_name: string;
    total_outstanding: number;
    months: string[];
    invoice_count: number;
  }>;
}

export type CitationLookupInput =
  | Customer360CitationInput
  | CustomerBookCitationInput
  | InboxCitationInput
  | PerformanceLandingCitationInput
  | PerformanceReportCitationInput
  | EscalationOverviewCitationInput
  | PostPaymentBookCitationInput
  | PostPaymentCustomerCitationInputWrap
  | MissPaymentOverviewCitationInput;

/**
 * Build a citation lookup for any supported scope. Unsupported scopes
 * (currently only `hidden`) return an empty object.
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
        silenceByAm: input.silenceByAm,
        topAtRisk: input.topAtRisk,
      });
    case "inbox":
      return buildInboxLookup({
        counts: input.counts,
        critical: input.critical,
        watching: input.watching,
        openTickets: input.openTickets,
      });
    case "performance-landing":
      return buildPerformanceLandingLookup({
        total_active_customers: input.total_active_customers,
        reports_generated_this_week: input.reports_generated_this_week,
        median_composite_score: input.median_composite_score,
      });
    case "performance-report":
      return buildPerformanceReportLookup(input);
    case "escalation-overview":
      return buildEscalationOverviewLookup({
        tickets: input.tickets,
        open_total: input.open_total,
        by_am: input.by_am,
        by_classification: input.by_classification,
        aged_14d_plus: input.aged_14d_plus,
        aged_30d_plus: input.aged_30d_plus,
      });
    case "post-payment-book":
      return buildPostPaymentBookLookup({
        counts: input.counts,
        customers: input.customers,
      });
    case "post-payment-customer":
      return buildPostPaymentCustomerLookup({
        cb_customer_id: input.cb_customer_id,
        biz_name: input.biz_name,
        verdict: input.verdict,
        verdict_one_line: input.verdict_one_line,
        plan: input.plan,
        first_payment_amount_cents: input.first_payment_amount_cents,
        key_flags: input.key_flags,
      });
    case "miss-payment-overview":
      return buildMissPaymentOverviewLookup({
        totals: input.totals,
        by_am: input.by_am,
        top_rows: input.top_rows,
        multi_month: input.multi_month,
      });
  }
}

function buildMissPaymentOverviewLookup(args: {
  totals: {
    total_balance: number;
    invoice_count: number;
    unique_customers: number;
    ach_in_flight: number;
    multi_month_count: number;
    auto_debit_off_balance: number;
    recovery_coverage_pct: number;
  };
  by_am: Array<{
    am_name: string;
    balance: number;
    invoice_count: number;
    customer_count: number;
  }>;
  top_rows: Array<{
    invoice_number: string;
    biz_name: string;
    am_name: string;
    amount_due: number;
    invoice_date: string;
    auto_debit: string;
    ach_status: string;
    status: string;
    ticket_id: string | null;
  }>;
  multi_month: Array<{
    key: string;
    biz_name: string;
    am_name: string;
    total_outstanding: number;
    months: string[];
    invoice_count: number;
  }>;
}): CitationLookup {
  const out: CitationLookup = {};

  // KPI totals — chips for headline numbers the model is likely to cite.
  out[makeCitationKey("count", "missed_invoice_total_balance_usd")] = {
    category: "count",
    label: "Total outstanding",
    value: `$${args.totals.total_balance.toLocaleString()}`,
  };
  out[makeCitationKey("count", "missed_invoice_count")] = {
    category: "count",
    label: "Open invoices",
    value: String(args.totals.invoice_count),
  };
  out[makeCitationKey("count", "missed_invoice_unique_customers")] = {
    category: "count",
    label: "Unique businesses",
    value: String(args.totals.unique_customers),
  };
  out[makeCitationKey("count", "missed_invoice_ach_in_flight")] = {
    category: "count",
    label: "ACH in flight",
    value: String(args.totals.ach_in_flight),
  };
  out[makeCitationKey("count", "missed_invoice_multi_month_customers")] = {
    category: "count",
    label: "Multi-month repeat customers",
    value: String(args.totals.multi_month_count),
  };
  out[makeCitationKey("count", "missed_invoice_auto_debit_off_balance_usd")] = {
    category: "count",
    label: "Auto-debit Off — total balance",
    value: `$${args.totals.auto_debit_off_balance.toLocaleString()}`,
  };
  out[makeCitationKey("count", "missed_invoice_recovery_coverage_pct")] = {
    category: "count",
    label: "Active recovery effort coverage",
    value: `${args.totals.recovery_coverage_pct}%`,
    raw: {
      meaning:
        "Share of open invoices with ACH in flight OR a rep annotation indicating contact made",
    },
  };

  // Per-AM rollup — one chip per AM in the top-8.
  for (const e of args.by_am) {
    out[makeCitationKey("count", `missed_invoice_balance_by_am:${e.am_name}`)] = {
      category: "count",
      label: `Outstanding — ${e.am_name}`,
      value: `$${e.balance.toLocaleString()}`,
      raw: {
        am_name: e.am_name,
        invoice_count: e.invoice_count,
        customer_count: e.customer_count,
      },
    };
  }

  // Per-invoice rows — billing chips keyed by invoice_number.
  for (const r of args.top_rows) {
    if (!r.invoice_number) continue;
    out[makeCitationKey("billing", `invoice:${r.invoice_number}`)] = {
      category: "billing",
      label: r.invoice_number,
      value: r.biz_name || "(unknown)",
      raw: {
        amount_due_usd: r.amount_due,
        am_name: r.am_name || null,
        invoice_date: r.invoice_date || null,
        auto_debit: r.auto_debit || null,
        ach_status: r.ach_status || null,
        status: r.status || null,
        ticket: r.ticket_id || null,
      },
    };
  }

  // Multi-month repeats — billing chips keyed by entity/customer key.
  for (const m of args.multi_month) {
    if (!m.key) continue;
    out[makeCitationKey("billing", `multi_month:${m.key}`)] = {
      category: "billing",
      label: m.biz_name || "(multi-month)",
      value: `$${m.total_outstanding.toLocaleString()} across ${m.invoice_count} invoices`,
      raw: {
        biz_name: m.biz_name || null,
        am_name: m.am_name || null,
        months: m.months.join(", "),
        invoice_count: m.invoice_count,
      },
    };
  }

  return out;
}

/**
 * Return whether the given scope has citation support. As of v3a.2 every
 * non-hidden scope builds a lookup.
 */
export function scopeHasCitationSupport(scope: AiScope): boolean {
  return scope.kind !== "hidden";
}
