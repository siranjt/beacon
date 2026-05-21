/**
 * Signal engine — reads EntityReportData and decides which actions trigger,
 * with what priority, and what personalization context to apply.
 *
 * Each signal is a pure function. The combiner runs them all and returns a
 * priority-sorted list. The reference report's 5 actions all have a
 * permanent "always-on" signal so the checklist never goes empty — but
 * priority shifts based on what's actually true in the data.
 *
 * Priority scale (higher = more urgent):
 *   100 = critical (act today)
 *    80 = strong (act this week)
 *    60 = relevant
 *    40 = baseline / always-on
 */

import type { EntityReportData } from "./types";
import type { ActionId } from "./library/types";

export type SignalContext = Record<string, string | number>;

export type TriggeredAction = {
  id: ActionId;
  priority: number;
  /** Human-readable explanation of why this was selected (for tooltips/debugging). */
  rationale: string;
  /** Variables to substitute into library copy at render time. */
  context: SignalContext;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  return n.toLocaleString("en-US");
}

/** Pulls a numeric value from a deeply nested key path on an unknown blob. */
function dig(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

function asNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Individual signals
// ---------------------------------------------------------------------------

/**
 * Photo-freshness signal.
 *
 * Promotes "upload photos" to high priority when:
 *   a) GBP photo count from the audit is low (<30), OR
 *   b) Profile clicks have dropped >30% from peak month, OR
 *   c) No clear data — falls back to baseline (always-on).
 */
function signalUploadPhotos(data: EntityReportData): TriggeredAction {
  const photoCount = asNumber(
    dig(data.forecast?.gbpAudit, [
      "zocaScoreData",
      "components",
      "photos",
      "details",
      "overallPhotosCount",
    ])
  );

  // Detect click dip from monthly trend
  const clicks = data.gbpClicks.map((m) => m.profileClicks);
  let peakClicks: number | null = null;
  let recentClicks: number | null = null;
  if (clicks.length >= 2) {
    peakClicks = Math.max(...clicks);
    recentClicks = clicks[clicks.length - 1];
  }
  const dipPct =
    peakClicks && peakClicks > 0 && recentClicks != null
      ? Math.round(((peakClicks - recentClicks) / peakClicks) * 100)
      : null;

  let priority = 40; // baseline always-on
  let rationale = "Photo freshness is an evergreen GBP lever.";

  if (photoCount != null && photoCount < 30) {
    priority = Math.max(priority, 80);
    rationale = `Only ${photoCount} GBP photos detected — below the 30-photo guideline.`;
  }
  if (dipPct != null && dipPct >= 30) {
    priority = Math.max(priority, 100);
    rationale = `Profile clicks dropped ${dipPct}% from peak (${fmtNum(peakClicks)} → ${fmtNum(recentClicks)}). Fresh photos are the fastest recovery lever.`;
  }

  return {
    id: "upload_photos",
    priority,
    rationale,
    context: {
      photo_count: photoCount ?? "",
      peak_clicks: peakClicks ?? "",
      recent_clicks: recentClicks ?? "",
      dip_pct: dipPct ?? "",
    },
  };
}

/**
 * Promotional-offer signal.
 *
 * Promotes when leads volume is below the forecast's per-month expectation,
 * or when a notable percentage of leads are unbooked.
 */
function signalRunOffer(data: EntityReportData): TriggeredAction {
  const leadCount = data.leads.length;
  const bookedCount = data.leads.filter((l) => l.status === "BOOKED").length;
  const bookedPct =
    leadCount > 0 ? Math.round((bookedCount / leadCount) * 100) : 0;

  const monthlyForecast = data.forecast?.predicted6MonthLeads
    ? Math.round(data.forecast.predicted6MonthLeads / 6)
    : null;

  let priority = 40;
  let rationale = "Promotional offers are an evergreen growth lever.";

  if (monthlyForecast != null && leadCount < monthlyForecast) {
    priority = Math.max(priority, 60);
    rationale = `Lead volume (${leadCount}) is below the monthly forecast (~${monthlyForecast}). A promotional offer will help close the gap.`;
  }
  if (bookedPct < 30 && leadCount >= 5) {
    priority = Math.max(priority, 60);
    rationale = `Only ${bookedPct}% of leads marked BOOKED — a fresh offer can re-engage your pipeline.`;
  }

  return {
    id: "run_offer",
    priority,
    rationale,
    context: {
      lead_count: leadCount,
      booked_pct: bookedPct,
      monthly_forecast: monthlyForecast ?? "",
    },
  };
}

/**
 * App-engagement signal.
 *
 * Promotes when many leads are still UNMARKED — a strong indicator the
 * customer isn't logging into the Zoca app.
 */
function signalUseAppMore(data: EntityReportData): TriggeredAction {
  const leadCount = data.leads.length;
  const unmarkedCount = data.leads.filter(
    (l) => (l.status || "").toUpperCase() === "UNMARKED"
  ).length;
  const unmarkedPct =
    leadCount > 0 ? Math.round((unmarkedCount / leadCount) * 100) : 0;

  let priority = 40;
  let rationale = "Daily app usage keeps your lead funnel and rankings in sync.";

  if (leadCount >= 5 && unmarkedPct >= 50) {
    priority = Math.max(priority, 80);
    rationale = `${unmarkedCount} of your last ${leadCount} leads are still UNMARKED (${unmarkedPct}%). Updating these in the Zoca app improves forecast accuracy.`;
  }
  if (leadCount >= 5 && unmarkedPct >= 75) {
    priority = Math.max(priority, 100);
  }

  return {
    id: "use_app_more",
    priority,
    rationale,
    context: {
      lead_count: leadCount,
      unmarked_count: unmarkedCount,
      unmarked_pct: unmarkedPct,
    },
  };
}

/**
 * Review-response signal.
 *
 * Reads the review-velocity sub-score from the audit. If velocity is low,
 * priority climbs.
 */
function signalRespondToReviews(data: EntityReportData): TriggeredAction {
  const velocityScore = asNumber(
    dig(data.forecast?.gbpAudit, [
      "zocaScoreData",
      "components",
      "reviews",
      "subComponents",
      "velocity",
      "percentageScore",
    ])
  );
  const consistencyScore = asNumber(
    dig(data.forecast?.gbpAudit, [
      "zocaScoreData",
      "components",
      "reviews",
      "subComponents",
      "consistency",
      "percentageScore",
    ])
  );

  let priority = 40;
  let rationale = "Responding to reviews is a confirmed local SEO ranking signal.";

  if (velocityScore != null && velocityScore < 50) {
    priority = Math.max(priority, 70);
    rationale = `Review-velocity score is ${Math.round(velocityScore)}% — responding to recent reviews will improve this.`;
  }
  if (consistencyScore != null && consistencyScore < 50) {
    priority = Math.max(priority, 60);
  }

  return {
    id: "respond_to_reviews",
    priority,
    rationale,
    context: {
      review_velocity_score: velocityScore ?? "",
      review_consistency_score: consistencyScore ?? "",
    },
  };
}

/**
 * Returning-client signal.
 *
 * Triggers prominently when ≥2 returning customers are in the lead list —
 * indicates a base of repeat business worth incentivizing.
 */
function signalReturningClient(data: EntityReportData): TriggeredAction {
  const returningLeads = data.leads.filter(
    (l) => (l.customerType || "").toLowerCase() === "returning"
  );
  const returningCount = returningLeads.length;
  const examples = returningLeads
    .slice(0, 3)
    .map((l) =>
      [l.firstName, l.lastName].filter(Boolean).join(" ").trim() || "a returning customer"
    )
    .join(", ");

  let priority = 30; // sit slightly below baseline if no signal
  let rationale = "Loyalty programs lift revenue consistency.";

  if (returningCount >= 2) {
    priority = Math.max(priority, 60);
    rationale = `You have ${returningCount} returning customers in the recent lead list (${examples}). They love you — reward them.`;
  }
  if (returningCount >= 5) {
    priority = Math.max(priority, 75);
  }

  return {
    id: "returning_client_incentive",
    priority,
    rationale,
    context: {
      returning_count: returningCount,
      returning_examples: examples,
    },
  };
}

// ---------------------------------------------------------------------------
// Combiner
// ---------------------------------------------------------------------------

/**
 * Runs all signals and returns the triggered actions sorted by priority desc.
 * The renderer typically takes the top N (5 in the reference report).
 */
export function runSignals(data: EntityReportData): TriggeredAction[] {
  const triggered: TriggeredAction[] = [
    signalUploadPhotos(data),
    signalRunOffer(data),
    signalUseAppMore(data),
    signalRespondToReviews(data),
    signalReturningClient(data),
  ];
  return triggered.sort((a, b) => b.priority - a.priority);
}
