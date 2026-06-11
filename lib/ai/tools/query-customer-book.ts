/**
 * query_customer_book — Beacon AI tool. Phase F-polish-AI Tier 2.
 *
 * Generalized read-only slice-and-dice over the active customer book.
 *
 * Problem this solves
 * -------------------
 * Pre-computing every possible cross-product (metric × group_by × bucket
 * thresholds) inflates the context blob without ever being exhaustive.
 * Beacon AI ends up saying "I don't have that breakdown" for any question
 * one inch off the menu. This tool moves the slicing to a single
 * parameterized executor: model picks metric + group_by + bucket spec +
 * optional filter, the executor runs over the in-memory snapshot, returns
 * rows. No pre-compute drift, no missing cross-products.
 *
 * Shape
 * -----
 * Input (Anthropic input_schema, JSON Schema flavour):
 *   metric:     enum — what to measure per customer
 *   group_by:   enum — how to slice the population
 *   buckets:    discriminator { type: 'threshold' | 'range' | 'sum' }
 *   filter:     optional array filters on am_name / tier / pod / lifecycle / stoplight
 *   sort_by:    enum — how to order returned rows
 *   limit:      max rows (default 50, cap 200)
 *
 * Output (`data` field on ToolResult):
 *   {
 *     metric, group_by, buckets, filter, sort_by, limit,
 *     total_customers_in_scope: number,
 *     rows: Array<{
 *       group_key: string,
 *       total_customers: number,
 *       bucket_counts: Record<string, number>,    // when buckets.type !== 'sum'
 *       sum: number,                              // when buckets.type === 'sum'
 *       avg: number,                              // when buckets.type === 'sum'
 *     }>,
 *   }
 *
 * Read-only — no mutation, no approval required (matches lookup_customer's
 * pattern). Still rate-limited and audit-logged at the executor endpoint.
 *
 * Citation handling
 * -----------------
 * The tool's `data` field carries the raw rows. The client renders them
 * inline; if the model continues the turn after the tool call, it can
 * reference rows by group_key + bucket_label. Citation keys for cells
 * (when the model formats them as a table) follow the pattern from
 * Tier 1: `count:query:<metric>:<group_key_slug>:<bucket_label>`. Built
 * by the client from the result payload — not pre-computed here.
 */

import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";
import { makeCitationKey, type CitationLookup } from "@/lib/ai/citations";

// ───────────────────────────── Types ─────────────────────────────────────

export type MetricKey =
  | "outbound_silence"
  | "inbound_silence"
  | "mrr"
  | "app_usage_30d"
  | "open_tickets"
  | "missed_payments"
  | "past_due_amount"
  | "composite_score";

export type GroupByKey =
  | "am"
  | "pod"
  | "tier"
  | "lifecycle_state"
  | "stoplight"
  | "none";

export type BucketSpec =
  | { type: "threshold"; values: number[] }
  | { type: "range"; ranges: Array<{ label: string; min: number; max: number }> }
  | { type: "sum" };

export interface QueryFilter {
  am_name?: string[];
  tier?: string[];
  pod?: string[];
  lifecycle_state?: Array<"active" | "newly_onboarded" | "resurrected">;
  stoplight?: Array<"RED" | "YELLOW" | "GREEN">;
}

export type SortBy = "group_key" | "total" | "first_bucket_desc" | "first_bucket_asc";

export interface QueryInput {
  metric: MetricKey;
  group_by: GroupByKey;
  buckets: BucketSpec;
  filter?: QueryFilter;
  sort_by?: SortBy;
  limit?: number;
}

export interface QueryRow {
  group_key: string;
  total_customers: number;
  bucket_counts?: Record<string, number>;
  sum?: number;
  avg?: number;
}

export interface QueryResult {
  metric: MetricKey;
  group_by: GroupByKey;
  buckets: BucketSpec;
  filter: QueryFilter | null;
  sort_by: SortBy;
  limit: number;
  total_customers_in_scope: number;
  rows: QueryRow[];
  /**
   * F-polish-AI Tier 4 — synthetic citation entries keyed by
   * `count:query:<metric>:<group_slug>:<bucket_label_or_sum>`. The client
   * merges these into the assistant turn's CitationLookup so cells the
   * model labels with `[cite:...]` chips render with proper popovers
   * instead of muted "(unverified)" fallback chips.
   */
  citations: CitationLookup;
}

// ────────────────────────── Metric extractors ───────────────────────────
//
// Each metric returns `number` (or null when truly missing). Conventions:
//   - days_since_*: null → 9999 so never-contacted customers hit every
//     silence threshold. Matches Tier 1's silence-by-AM behaviour.
//   - counts that default to 0 (open_tickets, missed_payments): null → 0.
//   - dollar metrics (mrr, past_due): null → 0.
//   - scores (composite, app_usage): null → 0.

function extractMetric(c: ScoredCustomerV2, metric: MetricKey): number {
  switch (metric) {
    case "outbound_silence":
      return c.metrics?.days_since_out ?? 9999;
    case "inbound_silence":
      return c.metrics?.days_since_in ?? 9999;
    case "mrr":
      return typeof c.plan_amount === "number" ? c.plan_amount : 0;
    case "app_usage_30d":
      return c.usage?.distinct_app_open_days_30d ?? 0;
    case "open_tickets":
      // Prefer Metabase-derived open_count when present, fall back to
      // BaseSheet legacy 30d counter.
      return (
        c.tickets?.open_count ??
        c.tickets?.open_tickets_30d ??
        0
      );
    case "missed_payments":
      return c.billing?.unpaid_invoice_count ?? 0;
    case "past_due_amount":
      // Stored as cents in the snapshot; expose as dollars to the model.
      return (c.billing?.total_amount_due_cents ?? 0) / 100;
    case "composite_score":
      return c.signals_v2?.composite ?? 0;
  }
}

// ────────────────────────── Group key extractor ─────────────────────────

function extractGroupKey(c: ScoredCustomerV2, groupBy: GroupByKey): string {
  if (groupBy === "none") return "all";
  if (groupBy === "am") {
    const v = c.am_name?.trim();
    return v ? v : "(Unassigned)";
  }
  if (groupBy === "pod") {
    const v = c.pod?.trim();
    return v ? v : "(Floating/Unassigned)";
  }
  if (groupBy === "tier") {
    const v = c.signals_v2?.tier;
    return v ? String(v) : "(No tier)";
  }
  if (groupBy === "lifecycle_state") {
    return c.lifecycle_state ?? "active";
  }
  if (groupBy === "stoplight") {
    return c.signals_v2?.stoplight ?? "(No stoplight)";
  }
  return "(Unknown)";
}

// ────────────────────────── Filter application ──────────────────────────

function matchesFilter(c: ScoredCustomerV2, f: QueryFilter | undefined): boolean {
  if (!f) return true;
  if (f.am_name && f.am_name.length > 0) {
    const cv = c.am_name?.trim() ?? "";
    if (!f.am_name.some((v) => v.trim().toLowerCase() === cv.toLowerCase())) {
      return false;
    }
  }
  if (f.tier && f.tier.length > 0) {
    const cv = c.signals_v2?.tier ?? "";
    if (!f.tier.some((v) => v.toLowerCase() === String(cv).toLowerCase())) {
      return false;
    }
  }
  if (f.pod && f.pod.length > 0) {
    const cv = c.pod?.trim() ?? "";
    if (!f.pod.some((v) => v.trim().toLowerCase() === cv.toLowerCase())) {
      return false;
    }
  }
  if (f.lifecycle_state && f.lifecycle_state.length > 0) {
    const cv = c.lifecycle_state ?? "active";
    if (!f.lifecycle_state.includes(cv)) return false;
  }
  if (f.stoplight && f.stoplight.length > 0) {
    const cv = c.signals_v2?.stoplight;
    if (!cv || !f.stoplight.includes(cv)) return false;
  }
  return true;
}

// ───────────────────────────── Bucketer ──────────────────────────────────

/**
 * Returns the unit suffix to use for threshold-bucket labels based on the
 * metric. Days-based metrics get 'd+' (e.g. '30d+'); count or score
 * metrics just get '+' (e.g. '3+'); dollar metrics get '$' prefix.
 * Keeps labels self-documenting in the model's eventual answer.
 */
function thresholdLabel(metric: MetricKey, value: number): string {
  switch (metric) {
    case "outbound_silence":
    case "inbound_silence":
      return `${value}d+`;
    case "mrr":
    case "past_due_amount":
      return `$${value}+`;
    case "app_usage_30d":
    case "open_tickets":
    case "missed_payments":
    case "composite_score":
      return `${value}+`;
  }
}

/**
 * Returns the bucket labels (in order) for a given spec. For 'sum' there
 * are no buckets — the executor falls through to a pure aggregation.
 */
function bucketLabels(metric: MetricKey, spec: BucketSpec): string[] {
  if (spec.type === "threshold") {
    return spec.values.map((v) => thresholdLabel(metric, v));
  }
  if (spec.type === "range") {
    return spec.ranges.map((r) => r.label);
  }
  return [];
}

/**
 * Returns the bucket labels a metric value falls into. A threshold value
 * v falls into EVERY threshold label where v >= t, so a customer at
 * 95-days-silent hits 30d+, 60d+, AND 90d+ — the correct semantics for
 * "customers silent for at least X days".
 *
 * A range value v falls into the FIRST range it matches (min <= v <= max),
 * giving disjoint buckets — the correct semantics for "customers with
 * MRR between $X and $Y".
 */
function bucketMembership(value: number, metric: MetricKey, spec: BucketSpec): string[] {
  if (spec.type === "threshold") {
    return spec.values
      .filter((t) => value >= t)
      .map((t) => thresholdLabel(metric, t));
  }
  if (spec.type === "range") {
    for (const r of spec.ranges) {
      if (value >= r.min && value <= r.max) return [r.label];
    }
    return [];
  }
  return [];
}

// ─────────────────────────── Core aggregator ────────────────────────────

/**
 * Runs the parameterized query over a customer list. Pure function —
 * no I/O. Exposed for unit testing without touching Postgres.
 */
export function runQuery(
  customers: ScoredCustomerV2[],
  input: QueryInput,
): QueryResult {
  const filter = input.filter ?? null;
  const sortBy: SortBy = input.sort_by ?? "first_bucket_desc";
  const limit = clamp(input.limit ?? 50, 1, 200);

  const scoped = customers.filter((c) => matchesFilter(c, filter ?? undefined));

  const labels = bucketLabels(input.metric, input.buckets);
  const isSum = input.buckets.type === "sum";

  // Group accumulator.
  type Acc = {
    total: number;
    bucket_counts: Record<string, number>;
    sum: number;
  };
  const groups = new Map<string, Acc>();

  for (const c of scoped) {
    const key = extractGroupKey(c, input.group_by);
    let acc = groups.get(key);
    if (!acc) {
      acc = {
        total: 0,
        bucket_counts: Object.fromEntries(labels.map((l) => [l, 0])),
        sum: 0,
      };
      groups.set(key, acc);
    }
    acc.total += 1;
    const value = extractMetric(c, input.metric);
    if (isSum) {
      acc.sum += value;
    } else {
      const memberships = bucketMembership(value, input.metric, input.buckets);
      for (const m of memberships) {
        if (m in acc.bucket_counts) {
          acc.bucket_counts[m] += 1;
        }
      }
    }
  }

  // Materialize rows.
  let rows: QueryRow[] = Array.from(groups.entries()).map(([group_key, acc]) => {
    if (isSum) {
      return {
        group_key,
        total_customers: acc.total,
        sum: round2(acc.sum),
        avg: acc.total > 0 ? round2(acc.sum / acc.total) : 0,
      };
    }
    return {
      group_key,
      total_customers: acc.total,
      bucket_counts: acc.bucket_counts,
    };
  });

  // Sort.
  rows = sortRows(rows, sortBy, labels, isSum);

  // Limit.
  if (rows.length > limit) rows = rows.slice(0, limit);

  // F-polish-AI Tier 4 — synthetic citations. One entry per (group, bucket)
  // for threshold/range, one per group for sum. The model can cite each
  // table cell with [cite:count:query:<metric>:<group_slug>:<label>] and
  // the client renders a real popover instead of a muted "(unverified)"
  // fallback chip.
  const citations = buildQueryCitations({
    metric: input.metric,
    rows,
    labels,
    isSum,
  });

  return {
    metric: input.metric,
    group_by: input.group_by,
    buckets: input.buckets,
    filter,
    sort_by: sortBy,
    limit,
    total_customers_in_scope: scoped.length,
    rows,
    citations,
  };
}

/**
 * Slug an arbitrary group_key (AM name, pod, tier, etc.) into a citation-safe
 * identifier. Lowercase, non-alphanumerics → underscores, trim, capped at 60
 * chars. Same shape as the customer-book outbound_silence_buckets_by_am
 * citation keys so they read consistently in the chip popover.
 */
function slugGroupKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "unknown";
}

/**
 * Build one citation entry per cell in the query result.
 *   - threshold / range mode: `count:query:<metric>:<group_slug>:<bucket_label>`
 *     emitted for every (group, bucket) pair, plus a `:total:<group_slug>` row.
 *   - sum mode: `count:query:<metric>:<group_slug>:sum` and `:avg:<group_slug>`,
 *     plus `:total:<group_slug>`.
 *
 * Exported separately so the test suite can assert citation keys without
 * touching Postgres.
 */
export function buildQueryCitations(args: {
  metric: MetricKey;
  rows: QueryRow[];
  labels: string[];
  isSum: boolean;
}): CitationLookup {
  const { metric, rows, labels, isSum } = args;
  const out: CitationLookup = {};

  for (const row of rows) {
    const slug = slugGroupKey(row.group_key);

    if (isSum) {
      if (typeof row.sum === "number") {
        out[makeCitationKey("count", `query:${metric}:${slug}:sum`)] = {
          category: "count",
          label: `${row.group_key} — ${metric} sum`,
          value: String(row.sum),
          raw: {
            group_key: row.group_key,
            metric,
            mode: "sum",
            total_customers: row.total_customers,
          },
        };
      }
      if (typeof row.avg === "number") {
        out[makeCitationKey("count", `query:${metric}:${slug}:avg`)] = {
          category: "count",
          label: `${row.group_key} — ${metric} avg`,
          value: String(row.avg),
          raw: {
            group_key: row.group_key,
            metric,
            mode: "avg",
            total_customers: row.total_customers,
          },
        };
      }
    } else if (row.bucket_counts) {
      for (const label of labels) {
        const count = row.bucket_counts[label] ?? 0;
        out[
          makeCitationKey("count", `query:${metric}:${slug}:${label}`)
        ] = {
          category: "count",
          label: `${row.group_key} — ${metric} ${label}`,
          value: String(count),
          raw: {
            group_key: row.group_key,
            metric,
            bucket: label,
            total_customers: row.total_customers,
          },
        };
      }
    }

    // Per-group total — handy when the model cites the "total customers"
    // column of the table.
    out[makeCitationKey("count", `query:${metric}:${slug}:total`)] = {
      category: "count",
      label: `${row.group_key} — total customers in scope`,
      value: String(row.total_customers),
      raw: { group_key: row.group_key, metric },
    };
  }

  return out;
}

function sortRows(
  rows: QueryRow[],
  by: SortBy,
  labels: string[],
  isSum: boolean,
): QueryRow[] {
  const firstLabel = labels[0];
  return [...rows].sort((a, b) => {
    if (by === "group_key") {
      return a.group_key.localeCompare(b.group_key);
    }
    if (by === "total") {
      return b.total_customers - a.total_customers;
    }
    if (isSum) {
      // For sum mode, "first_bucket_*" sorts on the sum value.
      const asum = a.sum ?? 0;
      const bsum = b.sum ?? 0;
      return by === "first_bucket_asc" ? asum - bsum : bsum - asum;
    }
    if (!firstLabel) return 0;
    const av = a.bucket_counts?.[firstLabel] ?? 0;
    const bv = b.bucket_counts?.[firstLabel] ?? 0;
    return by === "first_bucket_asc" ? av - bv : bv - av;
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ───────────────────────── Input parsing + guards ───────────────────────

function parseInput(args: Record<string, unknown>): QueryInput | { error: string } {
  const metric = args.metric;
  const validMetrics: MetricKey[] = [
    "outbound_silence",
    "inbound_silence",
    "mrr",
    "app_usage_30d",
    "open_tickets",
    "missed_payments",
    "past_due_amount",
    "composite_score",
  ];
  if (typeof metric !== "string" || !validMetrics.includes(metric as MetricKey)) {
    return { error: `metric must be one of: ${validMetrics.join(", ")}` };
  }

  const groupBy = args.group_by;
  const validGroupBys: GroupByKey[] = ["am", "pod", "tier", "lifecycle_state", "stoplight", "none"];
  if (typeof groupBy !== "string" || !validGroupBys.includes(groupBy as GroupByKey)) {
    return { error: `group_by must be one of: ${validGroupBys.join(", ")}` };
  }

  const buckets = args.buckets;
  if (!buckets || typeof buckets !== "object") {
    return { error: "buckets must be an object with a 'type' field" };
  }
  const bt = (buckets as Record<string, unknown>).type;
  let parsedBuckets: BucketSpec;
  if (bt === "threshold") {
    const values = (buckets as Record<string, unknown>).threshold_values;
    if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === "number")) {
      return { error: "buckets.type='threshold' requires non-empty threshold_values: number[]" };
    }
    parsedBuckets = { type: "threshold", values: (values as number[]).slice().sort((a, b) => a - b) };
  } else if (bt === "range") {
    const ranges = (buckets as Record<string, unknown>).ranges;
    if (!Array.isArray(ranges) || ranges.length === 0) {
      return { error: "buckets.type='range' requires non-empty ranges: Array<{label,min,max}>" };
    }
    const cleaned: Array<{ label: string; min: number; max: number }> = [];
    for (const r of ranges) {
      if (!r || typeof r !== "object") {
        return { error: "each range must be an object with label/min/max" };
      }
      const rr = r as Record<string, unknown>;
      if (typeof rr.label !== "string" || typeof rr.min !== "number" || typeof rr.max !== "number") {
        return { error: "each range needs string label, number min, number max" };
      }
      cleaned.push({ label: rr.label, min: rr.min, max: rr.max });
    }
    parsedBuckets = { type: "range", ranges: cleaned };
  } else if (bt === "sum") {
    parsedBuckets = { type: "sum" };
  } else {
    return { error: "buckets.type must be 'threshold' | 'range' | 'sum'" };
  }

  const filterIn = args.filter;
  let filter: QueryFilter | undefined;
  if (filterIn && typeof filterIn === "object") {
    const f = filterIn as Record<string, unknown>;
    filter = {};
    for (const key of ["am_name", "tier", "pod"] as const) {
      const v = f[key];
      if (v !== undefined) {
        if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
          return { error: `filter.${key} must be a string array` };
        }
        filter[key] = v as string[];
      }
    }
    if (f.lifecycle_state !== undefined) {
      const v = f.lifecycle_state;
      const allowed = ["active", "newly_onboarded", "resurrected"] as const;
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && (allowed as readonly string[]).includes(x))) {
        return { error: `filter.lifecycle_state must be subset of: ${allowed.join(", ")}` };
      }
      filter.lifecycle_state = v as QueryFilter["lifecycle_state"];
    }
    if (f.stoplight !== undefined) {
      const v = f.stoplight;
      const allowed = ["RED", "YELLOW", "GREEN"] as const;
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && (allowed as readonly string[]).includes(x))) {
        return { error: `filter.stoplight must be subset of: ${allowed.join(", ")}` };
      }
      filter.stoplight = v as QueryFilter["stoplight"];
    }
  }

  const sortBy = args.sort_by;
  let parsedSortBy: SortBy = "first_bucket_desc";
  if (sortBy !== undefined) {
    const validSorts: SortBy[] = ["group_key", "total", "first_bucket_desc", "first_bucket_asc"];
    if (typeof sortBy !== "string" || !validSorts.includes(sortBy as SortBy)) {
      return { error: `sort_by must be one of: ${validSorts.join(", ")}` };
    }
    parsedSortBy = sortBy as SortBy;
  }

  const limit = args.limit;
  let parsedLimit = 50;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
      return { error: "limit must be a positive number" };
    }
    parsedLimit = limit;
  }

  return {
    metric: metric as MetricKey,
    group_by: groupBy as GroupByKey,
    buckets: parsedBuckets,
    filter,
    sort_by: parsedSortBy,
    limit: parsedLimit,
  };
}

// ─────────────────────────── Tool definition ────────────────────────────

export const queryCustomerBookTool: BeaconTool = {
  name: "query_customer_book",
  description:
    "Ad-hoc slice-and-dice over the active customer book — pick a metric (outbound_silence, inbound_silence, mrr, app_usage_30d, open_tickets, missed_payments, past_due_amount, composite_score), a group_by (am, pod, tier, lifecycle_state, stoplight, none), and a bucket spec (threshold = cumulative 'X+'; range = disjoint bands; sum = aggregate). Optional `filter` narrows before grouping. Read-only.\n" +
    "If the answer is already in CONTEXT.outbound_silence_buckets_by_am or CONTEXT.health_summary, answer directly — only call this for off-menu slices.\n" +
    "Trigger phrases: \"how many customers haven't we contacted in 30/60/90 days by AM?\", \"MRR by tier\", \"open tickets by pod\", \"composite 80+ by stoplight\".",
  input_schema: {
    type: "object",
    properties: {
      metric: {
        type: "string",
        enum: [
          "outbound_silence",
          "inbound_silence",
          "mrr",
          "app_usage_30d",
          "open_tickets",
          "missed_payments",
          "past_due_amount",
          "composite_score",
        ],
        description:
          "What to measure per customer. outbound_silence = days since last outbound touch (use with threshold buckets for 'haven't contacted in X days'). inbound_silence = days since last inbound touch. mrr = plan amount per cycle in dollars (use with sum for revenue rollups). app_usage_30d = distinct days the salon opened the Zoca app in the last 30 days (0-30). open_tickets = current open Linear/Metabase ticket count. missed_payments = unpaid invoice count. past_due_amount = total past-due dollars. composite_score = signals composite 0-100.",
      },
      group_by: {
        type: "string",
        enum: ["am", "pod", "tier", "lifecycle_state", "stoplight", "none"],
        description:
          "How to slice the population. 'am' groups by am_name (unassigned customers fall into '(Unassigned)'). 'pod' groups by Pod 1-5 / Floating. 'tier' groups by signals tier (Critical/At Risk/Watch/Healthy or similar). 'lifecycle_state' groups by active/newly_onboarded/resurrected (recently-churned customers are dropped from the book, never appear). 'stoplight' groups by RED/YELLOW/GREEN. 'none' returns a single row with totals across the whole book.",
      },
      buckets: {
        type: "object",
        description:
          "How to bucket the metric value per customer. 'threshold' for 'X+ days/units' style cumulative buckets (a customer at 95 days silent counts toward 30+, 60+, AND 90+ buckets). 'range' for disjoint min-max bands (a customer at $250 MRR counts only toward the band that contains 250). 'sum' for pure aggregation — returns sum + avg per group, no buckets.",
        properties: {
          type: {
            type: "string",
            enum: ["threshold", "range", "sum"],
            description:
              "Bucket strategy. Use 'threshold' for 'haven't done X in Y days/units' questions. Use 'range' for distribution questions. Use 'sum' for rollup questions ('total MRR by tier').",
          },
          threshold_values: {
            type: "array",
            items: { type: "number" },
            description:
              "Required when type='threshold'. Threshold values in the metric's unit (e.g. [30, 60, 90, 120] for outbound_silence in days). The executor labels each as 'Xd+' or 'X+' depending on metric.",
          },
          ranges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Display label e.g. '$0-$200' or '0-29'" },
                min: { type: "number" },
                max: { type: "number" },
              },
              required: ["label", "min", "max"],
            },
            description:
              "Required when type='range'. Array of disjoint min/max bands with display labels. A customer is placed in the first matching band.",
          },
        },
        required: ["type"],
      },
      filter: {
        type: "object",
        description:
          "Optional filter applied BEFORE grouping. Combine multiple filters (AND across keys, OR within an array). Example: filter only RED At Risk customers in Pod 3 → {stoplight:['RED'], tier:['At Risk'], pod:['Pod 3']}.",
        properties: {
          am_name: { type: "array", items: { type: "string" } },
          tier: { type: "array", items: { type: "string" } },
          pod: { type: "array", items: { type: "string" } },
          lifecycle_state: {
            type: "array",
            items: {
              type: "string",
              enum: ["active", "newly_onboarded", "resurrected"],
            },
          },
          stoplight: {
            type: "array",
            items: { type: "string", enum: ["RED", "YELLOW", "GREEN"] },
          },
        },
      },
      sort_by: {
        type: "string",
        enum: ["group_key", "total", "first_bucket_desc", "first_bucket_asc"],
        description:
          "Row ordering. 'group_key' = alphabetical by group name. 'total' = by total customers per group desc. 'first_bucket_desc' (default) = by the count in the first bucket descending (so 'most silent first' for threshold buckets). 'first_bucket_asc' = ascending. For sum-mode queries 'first_bucket_*' sorts on the sum value.",
      },
      limit: {
        type: "number",
        description: "Max number of rows to return. Default 50, hard cap 200.",
      },
    },
    required: ["metric", "group_by", "buckets"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const parsed = parseInput(args);
    if ("error" in parsed) {
      return { ok: false, error: parsed.error };
    }

    try {
      const snap = await readLatestSnapshotV2();
      // F-purge-churned — snapshot already excludes recently-churned rows.
      const activeBook = snap?.customers ?? [];

      const result = runQuery(activeBook, parsed);

      // Audit log — read-only, but we still want to see how often Beacon AI
      // reaches for this tool and on what slice. The activity row carries
      // the parsed input so we can later mine "which slices are common".
      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:query_customer_book",
        surface: "customer-book",
        entity_id: null,
        metadata: {
          source: "beacon_ai",
          tool: "query_customer_book",
          metric: parsed.metric,
          group_by: parsed.group_by,
          bucket_type: parsed.buckets.type,
          filter_keys: parsed.filter ? Object.keys(parsed.filter) : [],
          row_count: result.rows.length,
          total_customers_in_scope: result.total_customers_in_scope,
        },
      });

      const summary =
        result.rows.length === 0
          ? `No customers matched the query (metric=${parsed.metric}, group_by=${parsed.group_by}).`
          : `${parsed.metric} by ${parsed.group_by}: ${result.rows.length} row${result.rows.length === 1 ? "" : "s"}, ${result.total_customers_in_scope} customer${result.total_customers_in_scope === 1 ? "" : "s"} in scope.`;

      return {
        ok: true,
        summary,
        data: result as unknown as Record<string, unknown>,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:query_customer_book:error",
        surface: "customer-book",
        entity_id: null,
        metadata: { source: "beacon_ai", error: msg },
      });
      return { ok: false, error: msg };
    }
  },
};
