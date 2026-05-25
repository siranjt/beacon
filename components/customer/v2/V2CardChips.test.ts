/**
 * Phase E-15.3b — V2CardChips pure-helper tests.
 *
 * Component rendering would need jsdom; we don't test that here. But
 * performanceChipSummary is a pure string transform — easy and worth
 * locking down. It produces the short "⚑ GBP ▼32% · 5wk zero" label that
 * appears on the customer card; getting it wrong means AMs see misleading
 * summary text.
 */

import { describe, it, expect } from "vitest";
import { performanceChipSummary } from "./V2CardChips";
import type { PerformanceMetrics } from "@/lib/customer/types";

function pm(over: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    entity_id: "e1",
    gbp_clicks_peak_complete_month: null,
    gbp_clicks_current_complete_month: null,
    gbp_clicks_in_progress_month: null,
    gbp_clicks_drop_pct: null,
    ytd_leads: null,
    prior_ytd_leads: null,
    ytd_leads_change_pct: null,
    active_ranking_count: null,
    rankings_top_3: null,
    rankings_top_10: null,
    rankings_outside_10: null,
    reviews_last_12_weeks_total: null,
    weeks_with_zero_reviews: null,
    review_target_weekly: null,
    flag: false,
    flag_reasons: [],
    ...over,
  };
}

describe("performanceChipSummary — flag gate", () => {
  it("returns null when flag is false (no perf concern)", () => {
    expect(performanceChipSummary(pm({ flag: false }))).toBeNull();
  });

  it("returns null when flag is true but no driver crosses threshold", () => {
    // Trivial flag with no quantitative driver above threshold → no chip text
    expect(
      performanceChipSummary(
        pm({
          flag: true,
          gbp_clicks_drop_pct: 10, // below 25 threshold
          weeks_with_zero_reviews: 1, // below 4 threshold
          ytd_leads_change_pct: -5, // not <= -20
        }),
      ),
    ).toBeNull();
  });
});

describe("performanceChipSummary — GBP drop driver", () => {
  it("at threshold (25%) → 'GBP ▼25%'", () => {
    expect(
      performanceChipSummary(pm({ flag: true, gbp_clicks_drop_pct: 25 })),
    ).toBe("GBP ▼25%");
  });

  it("rounds the drop percentage", () => {
    expect(
      performanceChipSummary(pm({ flag: true, gbp_clicks_drop_pct: 32.7 })),
    ).toBe("GBP ▼33%");
  });

  it("severe drop → still single chip text", () => {
    expect(
      performanceChipSummary(pm({ flag: true, gbp_clicks_drop_pct: 80 })),
    ).toBe("GBP ▼80%");
  });
});

describe("performanceChipSummary — zero-reviews driver", () => {
  it("at threshold (4 weeks) → '4wk zero'", () => {
    expect(
      performanceChipSummary(pm({ flag: true, weeks_with_zero_reviews: 4 })),
    ).toBe("4wk zero");
  });

  it("longer dry-spell → still shows count", () => {
    expect(
      performanceChipSummary(pm({ flag: true, weeks_with_zero_reviews: 9 })),
    ).toBe("9wk zero");
  });
});

describe("performanceChipSummary — YTD leads driver", () => {
  it("at threshold (-20%) → 'YTD ▼20%'", () => {
    expect(
      performanceChipSummary(pm({ flag: true, ytd_leads_change_pct: -20 })),
    ).toBe("YTD ▼20%");
  });

  it("uses abs() and rounds", () => {
    expect(
      performanceChipSummary(pm({ flag: true, ytd_leads_change_pct: -42.6 })),
    ).toBe("YTD ▼43%");
  });

  it("positive YTD change doesn't trip the down-arrow driver", () => {
    expect(
      performanceChipSummary(
        pm({
          flag: true,
          ytd_leads_change_pct: 30, // up, not down
        }),
      ),
    ).toBeNull();
  });
});

describe("performanceChipSummary — multi-driver composition", () => {
  it("joins multiple drivers with ' · '", () => {
    expect(
      performanceChipSummary(
        pm({
          flag: true,
          gbp_clicks_drop_pct: 40,
          weeks_with_zero_reviews: 6,
        }),
      ),
    ).toBe("GBP ▼40% · 6wk zero");
  });

  it("caps at 2 drivers (avoids chip-text overflow)", () => {
    const text = performanceChipSummary(
      pm({
        flag: true,
        gbp_clicks_drop_pct: 40,
        weeks_with_zero_reviews: 6,
        ytd_leads_change_pct: -30,
      }),
    );
    expect(text).not.toBeNull();
    // 2 separators would mean 3 drivers — assert at most 1 separator.
    const sepCount = (text ?? "").split(" · ").length - 1;
    expect(sepCount).toBeLessThanOrEqual(1);
  });

  it("preserves order: GBP first, then reviews, then YTD", () => {
    expect(
      performanceChipSummary(
        pm({
          flag: true,
          gbp_clicks_drop_pct: 40,
          weeks_with_zero_reviews: 6,
        }),
      ),
    ).toBe("GBP ▼40% · 6wk zero");
  });
});
