/**
 * get_review_summary — Beam tool. META-A3 (2026-06-11).
 *
 * Pulls live customer reviews for ONE customer from Aurora db=7
 * (`reviews.reviews`) over a sliding window (default 90 days). Answers
 * questions like "what's their rating?" / "how many reviews this month?" /
 * "is the trend up or down?".
 *
 * Trend derivation: split the window in half, compare avg star rating on
 * the older half vs the newer half. >+0.2 = up, <-0.2 = down, else flat.
 *
 * Read-only. Cached for 5 min in-process. Soft-fails to found=false on
 * empty data and on Metabase outage.
 */

import { runQuery, DB } from "@/lib/metabase";
import { logUmbrellaActivity } from "@/lib/activity/log";
import { getCachedContext, makeCacheKey } from "@/lib/ai/context-cache";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 365;
const MIN_WINDOW_DAYS = 7;
const RECENT_LIMIT = 3;
const TREND_DELTA = 0.2;
const CACHE_TTL_MS = 5 * 60 * 1000;

type ReviewRow = {
  id: string | null;
  rating: number | string | null;
  comment: string | null;
  reviewer_name: string | null;
  created_at: string;
} & Record<string, unknown>;

/**
 * SQL — FROM reviews.reviews WHERE entity_id = :eid AND
 * created_at >= NOW() - :days days. Ordered desc.
 *
 * Schema gotchas (verified 2026-06-11):
 *   - `rating` is a USER-DEFINED enum with text values
 *     ZERO/ONE/TWO/THREE/FOUR/FIVE (may be NULL). We map to integer 0-5
 *     in SQL so the existing toNum() coercion still works.
 *   - The comment column is `review_text` (character varying), NOT `comment`.
 *   - `entity_id` is `uuid` so we cast the bind param.
 */
const SQL_REVIEWS = `
SELECT
  id::text AS id,
  CASE rating::text
    WHEN 'ZERO'  THEN 0
    WHEN 'ONE'   THEN 1
    WHEN 'TWO'   THEN 2
    WHEN 'THREE' THEN 3
    WHEN 'FOUR'  THEN 4
    WHEN 'FIVE'  THEN 5
    ELSE NULL
  END AS rating,
  review_text AS comment,
  reviewer_name,
  created_at::text AS created_at
FROM reviews.reviews
WHERE entity_id = {{entity_id}}::uuid
  AND created_at >= NOW() - ({{window_days}}::int * INTERVAL '1 day')
ORDER BY created_at DESC
LIMIT 500
`;

type RatingTrend = "up" | "flat" | "down";

interface ReviewSummary {
  entity_id: string;
  window_days: number;
  found: boolean;
  total_reviews: number;
  avg_rating: number | null;
  reviews_per_week_avg: number;
  weeks_with_zero_reviews: number;
  rating_trend: RatingTrend;
  trend_detail: {
    first_half_avg: number | null;
    second_half_avg: number | null;
  };
  recent_3_reviews: Array<{
    id: string | null;
    rating: number | null;
    comment_preview: string | null;
    reviewer_name: string | null;
    created_at: string;
  }>;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clipComment(s: string | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

function deriveTrend(
  rows: ReviewRow[],
  cutoffMs: number,
): { trend: RatingTrend; first: number | null; second: number | null } {
  // rows are sorted desc by created_at — split at the midpoint of the window.
  const firstHalf: number[] = [];
  const secondHalf: number[] = [];
  for (const r of rows) {
    const rating = toNum(r.rating);
    if (rating == null) continue;
    const ts = Date.parse(r.created_at);
    if (!Number.isFinite(ts)) continue;
    if (ts >= cutoffMs) {
      secondHalf.push(rating);
    } else {
      firstHalf.push(rating);
    }
  }
  const avg = (arr: number[]): number | null =>
    arr.length > 0 ? arr.reduce((s, n) => s + n, 0) / arr.length : null;

  const first = avg(firstHalf);
  const second = avg(secondHalf);
  let trend: RatingTrend = "flat";
  if (first != null && second != null) {
    const delta = second - first;
    if (delta >= TREND_DELTA) trend = "up";
    else if (delta <= -TREND_DELTA) trend = "down";
  }
  return { trend, first, second };
}

async function fetchReviewSummary(
  entityId: string,
  windowDays: number,
): Promise<ReviewSummary> {
  const rows = await runQuery<ReviewRow>({
    database: DB.AURORA,
    sql: SQL_REVIEWS,
    params: { entity_id: entityId, window_days: windowDays },
  });

  if (rows.length === 0) {
    return {
      entity_id: entityId,
      window_days: windowDays,
      found: false,
      total_reviews: 0,
      avg_rating: null,
      reviews_per_week_avg: 0,
      weeks_with_zero_reviews: Math.floor(windowDays / 7),
      rating_trend: "flat",
      trend_detail: { first_half_avg: null, second_half_avg: null },
      recent_3_reviews: [],
    };
  }

  const ratings = rows
    .map((r) => toNum(r.rating))
    .filter((n): n is number => n != null);
  const avgRating =
    ratings.length > 0
      ? Math.round((ratings.reduce((s, n) => s + n, 0) / ratings.length) * 100) /
        100
      : null;

  // Bucketize into weeks (0 = most recent 7d, 1 = 7-14d ago, …).
  const totalWeeks = Math.max(1, Math.floor(windowDays / 7));
  const reviewsPerWeek = Math.round((rows.length / totalWeeks) * 100) / 100;

  const weeksWithReviews = new Set<number>();
  const now = Date.now();
  for (const r of rows) {
    const ts = Date.parse(r.created_at);
    if (!Number.isFinite(ts)) continue;
    const daysAgo = Math.floor((now - ts) / (24 * 60 * 60 * 1000));
    const weekBucket = Math.floor(daysAgo / 7);
    if (weekBucket < totalWeeks) weeksWithReviews.add(weekBucket);
  }
  const weeksWithZero = Math.max(0, totalWeeks - weeksWithReviews.size);

  const cutoffMs = now - (windowDays / 2) * 24 * 60 * 60 * 1000;
  const { trend, first, second } = deriveTrend(rows, cutoffMs);

  const recent = rows.slice(0, RECENT_LIMIT).map((r) => ({
    id: r.id ?? null,
    rating: toNum(r.rating),
    comment_preview: clipComment(r.comment),
    reviewer_name: r.reviewer_name,
    created_at: r.created_at,
  }));

  return {
    entity_id: entityId,
    window_days: windowDays,
    found: true,
    total_reviews: rows.length,
    avg_rating: avgRating,
    reviews_per_week_avg: reviewsPerWeek,
    weeks_with_zero_reviews: weeksWithZero,
    rating_trend: trend,
    trend_detail: {
      first_half_avg: first != null ? Math.round(first * 100) / 100 : null,
      second_half_avg: second != null ? Math.round(second * 100) / 100 : null,
    },
    recent_3_reviews: recent,
  };
}

export const getReviewSummaryTool: BeaconTool = {
  name: "get_review_summary",
  description:
    "Live customer-review pull for ONE customer from Aurora (reviews.reviews) over a sliding window (default 90 days). Returns total review count, average star rating, reviews-per-week average, weeks with zero reviews, recent 3 reviews (rating + preview), and a rating_trend (up/flat/down) computed by comparing window halves. Read-only, in-process 5-min cache. Soft-fails to found=false on empty data and on Metabase outage.\n" +
    "Trigger phrases: \"how many reviews?\", \"what's their rating?\", \"are reviews trending up or down?\", \"any weeks with zero reviews?\", \"recent reviews?\".",
  input_schema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description:
          "The customer's entity_id (UUID). Resolve via lookup_customer or from CONTEXT first.",
        minLength: 8,
      },
      window_days: {
        type: "integer",
        description: `Sliding window in days. Default ${DEFAULT_WINDOW_DAYS}. Min 7, max ${MAX_WINDOW_DAYS}.`,
        minimum: MIN_WINDOW_DAYS,
        maximum: MAX_WINDOW_DAYS,
      },
    },
    required: ["entity_id"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const entityId =
      typeof args.entity_id === "string" ? args.entity_id.trim() : "";
    if (!entityId) {
      return { ok: false, error: "entity_id is required" };
    }

    const rawWindow =
      typeof args.window_days === "number" ? Math.floor(args.window_days) : NaN;
    const windowDays =
      Number.isFinite(rawWindow) && rawWindow >= MIN_WINDOW_DAYS
        ? Math.min(rawWindow, MAX_WINDOW_DAYS)
        : DEFAULT_WINDOW_DAYS;

    const cacheKey = makeCacheKey("review-summary", {
      entity: entityId,
      window: windowDays,
    });

    try {
      const data = await getCachedContext(
        cacheKey,
        () => fetchReviewSummary(entityId, windowDays),
        { ttlMs: CACHE_TTL_MS },
      );

      const summary = data.found
        ? `Entity ${entityId.slice(0, 8)}: ${data.total_reviews} reviews in last ${windowDays}d, ` +
          `avg ${data.avg_rating ?? "n/a"} stars, ` +
          `${data.reviews_per_week_avg}/wk, trend ${data.rating_trend}, ` +
          `${data.weeks_with_zero_reviews} silent weeks.`
        : `No reviews for entity ${entityId.slice(0, 8)} in the last ${windowDays} days.`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:get_review_summary",
        surface: "customer-360",
        entity_id: entityId,
        metadata: {
          tool: "get_review_summary",
          window_days: windowDays,
          total_reviews: data.total_reviews,
          avg_rating: data.avg_rating,
          rating_trend: data.rating_trend,
          weeks_with_zero: data.weeks_with_zero_reviews,
        },
      });

      return { ok: true, summary, data: data as unknown as Record<string, unknown> };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: `Review summary fetch failed: ${msg.slice(0, 200)}`,
      };
    }
  },
};
