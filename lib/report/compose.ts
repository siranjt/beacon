/**
 * Compose layer — turns raw EntityReportData into a render-ready
 * ComposedReport that both the HTML page and the DOCX generator consume.
 *
 * Derives:
 *  - Snapshot tiles (4): YTD GBP leads, booked count, predicted revenue, weekly review target
 *  - Lead-source mix (for the "all leads from GBP" callout)
 *  - GBP clicks trend with peak/current and dip pct
 *  - RCA stats (always show — banner shows specific dip metrics if a dip is detected)
 *  - Sampled monthly clicks (5 evenly-spaced points for the table)
 *  - Action checklist (top 5 by priority)
 *  - Report month (from "today")
 */

import { buildActionChecklist, type RenderedAction } from "./checklist";
import type {
  EntityReportData,
  Forecast,
  GbpMonthlyClicks,
  KeywordRanking,
  Lead,
  LocationIdentity,
} from "./types";

export type SnapshotTiles = {
  totalGbpLeadsYtd: number;
  bookedLeads: number;
  predicted6MonthRevenue: number | null;
  predicted6MonthLeads: number | null;
  weeklyReviewTarget: number | null;
};

export type LeadSourceMixEntry = {
  source: string;
  count: number;
  pct: number;
};

export type ClicksTrendStats = {
  /** Up to 5 evenly-spaced sample months for the trend table. */
  sampledMonths: GbpMonthlyClicks[];
  /** Peak month observed. */
  peak: { month: string; clicks: number } | null;
  /** Most recent month. */
  current: { month: string; clicks: number } | null;
  /** % decline from peak to current (positive = decline). null if no peak/current. */
  dipPct: number | null;
};

export type RcaSection = {
  /** Always rendered now per requirements; banner copy varies by dip. */
  showDipBanner: boolean;
  peak: { month: string; clicks: number } | null;
  current: { month: string; clicks: number } | null;
  dipPct: number | null;
  /** Optional Linear ticket URL — falls back to undefined if not provided. */
  ticketUrl?: string;
  ticketId?: string;
  status?: string;
};

export type ComposedReport = {
  data: EntityReportData;
  identity: LocationIdentity;
  snapshot: SnapshotTiles;
  leadSourceMix: LeadSourceMixEntry[];
  clicksTrend: ClicksTrendStats;
  rca: RcaSection;
  keywords: KeywordRanking[];
  leads: Lead[];
  forecast: Forecast | null;
  actions: RenderedAction[];
  growthManagerName: string;
  accountExecutiveName: string | null;
  reportMonth: string;
  reportYear: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parseYearMonth(s: string): { year: number; month: number } {
  // Accepts "YYYY-MM-DD" — picks first 7 chars
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(5, 7), 10);
  return { year: y, month: m };
}

function fmtMonth(s: string): string {
  const { year, month } = parseYearMonth(s);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return s;
  return `${MONTH_NAMES[month - 1] ?? "?"} ${year}`;
}

function shortMonth(s: string): string {
  const { year, month } = parseYearMonth(s);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return s;
  const mm = (MONTH_NAMES[month - 1] ?? "").slice(0, 3);
  return `${mm} ${String(year).slice(2)}`;
}

function pickEvenlySpaced<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice();
  const step = (arr.length - 1) / (n - 1);
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    out.push(arr[Math.round(i * step)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildSnapshot(data: EntityReportData, ytdStart: Date): SnapshotTiles {
  const ytdLeads = data.leads.filter((l) => {
    const t = Date.parse(l.createdAt);
    return Number.isFinite(t) && t >= ytdStart.getTime() && l.isGbpSourced;
  });
  return {
    totalGbpLeadsYtd: ytdLeads.length,
    bookedLeads: ytdLeads.filter((l) => l.status === "BOOKED").length,
    predicted6MonthRevenue: data.forecast?.predicted6MonthRevenue ?? null,
    predicted6MonthLeads: data.forecast?.predicted6MonthLeads ?? null,
    weeklyReviewTarget: data.forecast?.reviewTarget ?? null,
  };
}

function buildLeadSourceMix(leads: Lead[]): LeadSourceMixEntry[] {
  if (!leads.length) return [];
  const counts = new Map<string, number>();
  for (const l of leads) {
    const key = l.isGbpSourced
      ? "Google Maps GBP"
      : l.utmSource && l.utmSource.trim() !== ""
        ? l.utmSource
        : "Other / Direct";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = leads.length;
  return Array.from(counts.entries())
    .map(([source, count]) => ({
      source,
      count,
      pct: Math.round((count / total) * 100),
    }))
    .sort((a, b) => b.count - a.count);
}

function buildClicksTrend(clicks: GbpMonthlyClicks[]): ClicksTrendStats {
  if (!clicks.length) {
    return { sampledMonths: [], peak: null, current: null, dipPct: null };
  }
  const peakRow = clicks.reduce((a, b) => (b.profileClicks > a.profileClicks ? b : a));
  const currentRow = clicks[clicks.length - 1];
  const peak = { month: peakRow.month, clicks: peakRow.profileClicks };
  const current = { month: currentRow.month, clicks: currentRow.profileClicks };
  const dipPct =
    peak.clicks > 0
      ? Math.round(((peak.clicks - current.clicks) / peak.clicks) * 100)
      : null;
  // Bias the sampling to the recent 18 months for relevance.
  const recent = clicks.slice(-18);
  const sampledMonths = pickEvenlySpaced(recent, 5);
  return { sampledMonths, peak, current, dipPct };
}

function buildRca(
  trend: ClicksTrendStats,
  ticket?: { url?: string; id?: string; status?: string }
): RcaSection {
  return {
    showDipBanner: trend.dipPct != null && trend.dipPct >= 30,
    peak: trend.peak,
    current: trend.current,
    dipPct: trend.dipPct,
    ticketUrl: ticket?.url,
    ticketId: ticket?.id,
    status: ticket?.status,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ComposeOptions = {
  /** Defaults to today. */
  asOf?: Date;
  /** Override the YTD start date for the snapshot. Defaults to Jan 1 of `asOf`. */
  ytdStart?: Date;
  /** Optional growth-manager name override (else falls back to placeholder). */
  growthManagerName?: string;
  /** Optional account-executive name. */
  accountExecutiveName?: string | null;
  /** Optional Linear ticket associated with the RCA. */
  rcaTicket?: { url?: string; id?: string; status?: string };
};

export function composeReport(
  data: EntityReportData,
  options: ComposeOptions = {}
): ComposedReport {
  const asOf = options.asOf ?? new Date();
  const ytdStart =
    options.ytdStart ?? new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));

  const snapshot = buildSnapshot(data, ytdStart);
  const leadSourceMix = buildLeadSourceMix(data.leads);
  const clicksTrend = buildClicksTrend(data.gbpClicks);
  const rca = buildRca(clicksTrend, options.rcaTicket);

  const actions = buildActionChecklist(data, {
    extraContext: {
      am_name: options.growthManagerName ?? "your account executive",
    },
  });

  const reportMonth = `${MONTH_NAMES[asOf.getUTCMonth()] ?? ""} ${asOf.getUTCFullYear()}`;

  return {
    data,
    identity: data.identity,
    snapshot,
    leadSourceMix,
    clicksTrend,
    rca,
    keywords: data.keywords,
    leads: data.leads,
    forecast: data.forecast,
    actions,
    growthManagerName: options.growthManagerName ?? "Your Growth Manager",
    accountExecutiveName: options.accountExecutiveName ?? null,
    reportMonth,
    reportYear: asOf.getUTCFullYear(),
  };
}

// Re-export helpers for renderers
export { fmtMonth, shortMonth };
