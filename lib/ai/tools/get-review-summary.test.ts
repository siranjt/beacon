/**
 * Tests for get_review_summary — META-A3.
 *
 * Covers:
 *   1. Happy path — Aurora returns a mix of ratings; we compute
 *      total_reviews, avg_rating, reviews_per_week_avg, weeks_with_zero,
 *      rating_trend, and recent_3 with comment previews.
 *   2. Empty branch — no rows → ok=true, found=false, sensible defaults.
 *   3. Error branch — Metabase 5xx → ok=false.
 *
 * Trend math is the most interesting bit: we feed older-half ratings of
 * ~3 and newer-half ratings of ~5 to assert "up".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolExecutionContext } from "./index";

const runQuery = vi.fn();
const logUmbrellaActivity = vi.fn();

vi.mock("@/lib/metabase", () => ({
  runQuery: (opts: unknown) => runQuery(opts),
  DB: { AURORA: 7, POSTGRES: 2, STAGING: 3 },
}));
vi.mock("@/lib/activity/log", () => ({
  logUmbrellaActivity: (...args: unknown[]) => logUmbrellaActivity(...args),
}));

import { getReviewSummaryTool } from "./get-review-summary";
import { _resetForTests } from "@/lib/ai/context-cache";

const ENTITY_ID = "e1b2c3d4-aaaa-bbbb-cccc-dddddddddddd";

function makeCtx(): ToolExecutionContext {
  return {
    amEmail: "am@zoca.com",
    amName: "Kanak sharma",
    role: "am",
    customerId: ENTITY_ID,
    customerName: "Pearl Salon",
    cbCustomerId: "cb_abc",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  logUmbrellaActivity.mockResolvedValue(undefined);
});

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("get_review_summary — happy path", () => {
  it("computes counts + avg + trend(up) + recent 3 + weeks-with-zero", async () => {
    // 90d window. Half = 45 days.
    // Newer half (0-45d ago) — three 5★ reviews.
    // Older half (45-90d ago) — two 3★ reviews.
    // Trend should be 5 - 3 = +2 → "up".
    runQuery.mockResolvedValueOnce([
      {
        id: "r1",
        rating: 5,
        comment: "Amazing service!",
        reviewer_name: "Aisha",
        created_at: daysAgoIso(5),
      },
      {
        id: "r2",
        rating: 5,
        comment: "Loved the cut",
        reviewer_name: "Brian",
        created_at: daysAgoIso(15),
      },
      {
        id: "r3",
        rating: 5,
        comment: null,
        reviewer_name: "Cara",
        created_at: daysAgoIso(30),
      },
      {
        id: "r4",
        rating: 3,
        comment: "Okay",
        reviewer_name: "Dan",
        created_at: daysAgoIso(60),
      },
      {
        id: "r5",
        rating: 3,
        comment: "Average",
        reviewer_name: "Eve",
        created_at: daysAgoIso(75),
      },
    ]);

    const result = await getReviewSummaryTool.execute(
      { entity_id: ENTITY_ID, window_days: 90 },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.found).toBe(true);
    expect(data.total_reviews).toBe(5);
    expect(data.avg_rating).toBeGreaterThan(4);
    expect(data.avg_rating).toBeLessThan(4.5);
    expect(data.rating_trend).toBe("up");
    const trendDetail = data.trend_detail as {
      first_half_avg: number | null;
      second_half_avg: number | null;
    };
    expect(trendDetail.first_half_avg).toBeCloseTo(3);
    expect(trendDetail.second_half_avg).toBeCloseTo(5);

    // 90d / 7 = 12 weeks; we touched ~4 of them.
    expect(data.weeks_with_zero_reviews).toBeGreaterThan(0);

    const recent = data.recent_3_reviews as Array<{ rating: number | null }>;
    expect(recent.length).toBe(3);
    expect(recent[0].rating).toBe(5);
    expect(logUmbrellaActivity).toHaveBeenCalledTimes(1);
  });

  it("flat trend when ratings are stable across both halves", async () => {
    runQuery.mockResolvedValueOnce([
      { id: "1", rating: 4, comment: null, reviewer_name: "A", created_at: daysAgoIso(10) },
      { id: "2", rating: 4, comment: null, reviewer_name: "B", created_at: daysAgoIso(60) },
    ]);

    const result = await getReviewSummaryTool.execute(
      { entity_id: ENTITY_ID, window_days: 90 },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.rating_trend).toBe("flat");
  });

  it("down trend when newer ratings drop below older", async () => {
    runQuery.mockResolvedValueOnce([
      { id: "1", rating: 2, comment: null, reviewer_name: "A", created_at: daysAgoIso(5) },
      { id: "2", rating: 2, comment: null, reviewer_name: "B", created_at: daysAgoIso(10) },
      { id: "3", rating: 5, comment: null, reviewer_name: "C", created_at: daysAgoIso(60) },
      { id: "4", rating: 5, comment: null, reviewer_name: "D", created_at: daysAgoIso(75) },
    ]);

    const result = await getReviewSummaryTool.execute(
      { entity_id: ENTITY_ID, window_days: 90 },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.rating_trend).toBe("down");
  });
});

describe("get_review_summary — empty branch", () => {
  it("no rows → ok=true with found=false", async () => {
    runQuery.mockResolvedValueOnce([]);

    const result = await getReviewSummaryTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.found).toBe(false);
    expect(data.total_reviews).toBe(0);
    expect(data.avg_rating).toBeNull();
    expect(data.reviews_per_week_avg).toBe(0);
    // Default window 90d → 12 weeks all silent.
    expect(data.weeks_with_zero_reviews).toBe(12);
    expect(data.rating_trend).toBe("flat");
    expect((data.recent_3_reviews as unknown[]).length).toBe(0);
  });
});

describe("get_review_summary — error branch", () => {
  it("Metabase 5xx → ok=false with helpful error", async () => {
    runQuery.mockRejectedValueOnce(new Error("Metabase /api/dataset 502: bad gateway"));

    const result = await getReviewSummaryTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Review summary fetch failed");
  });

  it("missing entity_id → ok=false, no Metabase call", async () => {
    const result = await getReviewSummaryTool.execute({}, makeCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("entity_id");
    expect(runQuery).not.toHaveBeenCalled();
  });
});
