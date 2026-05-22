"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (0 hex/rgba + 11 tailwind-rose swept)

import type { PerformanceMetrics } from "@/lib/customer/types";

type Tier = "RED" | "YELLOW" | "GREEN";

type Props = {
  performance: PerformanceMetrics | null;
  /**
   * Phase 26 — tier passed in from the parent card so the trajectory headline
   * picks the right tone. Falls back to inferring from the `flag` field when
   * not supplied (older callers).
   */
  tier?: Tier;
};

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Math.round(n).toLocaleString();
}

function formatPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(0)}%`;
}

function PctBadge({
  value,
  lowerIsBetter,
  title,
}: {
  value: number | null | undefined;
  lowerIsBetter?: boolean;
  title?: string;
}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return (
      <span className="text-[10px] text-zoca-text-2" title={title}>
        —
      </span>
    );
  }
  if (value === 0) {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded-zoca-pill bg-zoca-bg-tint px-1.5 py-0.5 text-[10px] font-medium text-zoca-text-2"
        title={title}
      >
        0%
      </span>
    );
  }
  const positive = value > 0;
  const isGood = lowerIsBetter ? !positive : positive;
  const tone = isGood
    ? "bg-emerald-500/18 text-emerald-700"
    : "bg-zoca-pink/18 text-zoca-pink-bright";
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-zoca-pill px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${tone}`}
      title={title}
    >
      {positive ? "▲" : "▼"} {Math.abs(value).toFixed(0)}%
    </span>
  );
}

/**
 * Phase 26 — inline directional arrow next to a raw metric value. Bigger and
 * more prominent than the corner PctBadge so AMs catch direction at a glance.
 */
function InlineArrow({
  value,
  lowerIsBetter,
  neutralThreshold = 5,
}: {
  value: number | null | undefined;
  lowerIsBetter?: boolean;
  neutralThreshold?: number;
}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return (
      <span aria-hidden className="text-zoca-text-3" style={{ fontSize: "11px" }}>
        —
      </span>
    );
  }
  if (Math.abs(value) < neutralThreshold) {
    return (
      <span aria-hidden className="text-zoca-text-3" style={{ fontSize: "13px", lineHeight: 1 }}>
        —
      </span>
    );
  }
  const positive = value > 0;
  const isGood = lowerIsBetter ? !positive : positive;
  const color = isGood ? "text-emerald-600" : "text-rose-600";
  return (
    <span
      aria-hidden
      className={`${color} font-bold`}
      style={{ fontSize: "13px", lineHeight: 1 }}
    >
      {positive ? "▲" : "▼"}
    </span>
  );
}

function DistributionBar({
  top3,
  top10,
  outside,
}: {
  top3: number | null;
  top10: number | null;
  outside: number | null;
}) {
  const a = top3 ?? 0;
  const b = top10 ?? 0;
  const c = outside ?? 0;
  const total = a + b + c;
  if (total === 0) return <span className="text-[10px] text-zoca-text-2">—</span>;
  const pA = (a / total) * 100;
  const pB = (b / total) * 100;
  const pC = (c / total) * 100;
  return (
    <div
      className="flex h-1.5 w-32 overflow-hidden rounded-full bg-zoca-bg-tint"
      role="img"
      aria-label={`Keyword rank distribution: ${a} top-3, ${b} top-10, ${c} outside`}
      title={`${a} top-3 · ${b} top-10 · ${c} outside-10`}
    >
      {pA > 0 && <div className="bg-emerald-400" style={{ width: `${pA}%` }} />}
      {pB > 0 && <div className="bg-amber-400" style={{ width: `${pB}%` }} />}
      {pC > 0 && <div className="bg-rose-400" style={{ width: `${pC}%` }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trajectory headline (Phase 26)
// ---------------------------------------------------------------------------

type HeadlineShape = {
  prefix: string;
  text: string;
  tone: "rose" | "emerald" | "zinc";
  explainer: string;
};

function computeHeadline(p: PerformanceMetrics, tier: Tier): HeadlineShape {
  // Concerning: flagged with at least one reason
  if (p.flag && (p.flag_reasons?.length ?? 0) > 0) {
    const reasons = p.flag_reasons.slice(0, 2).join(", ");
    return {
      prefix: "▼ Concerning",
      text: reasons,
      tone: "rose",
      explainer: `Flagged because: ${p.flag_reasons.join(" · ")}`,
    };
  }
  // Strong: clear positive YoY leads + no big visibility drop
  const strongLeads =
    p.ytd_leads_change_pct !== null && p.ytd_leads_change_pct >= 20;
  const visibilitySteady =
    p.gbp_clicks_drop_pct === null || p.gbp_clicks_drop_pct < 15;
  if (strongLeads && visibilitySteady) {
    return {
      prefix: "▲ Strong",
      text: `leads up ${(p.ytd_leads_change_pct as number).toFixed(0)}% YoY, visibility steady`,
      tone: "emerald",
      explainer:
        "YTD leads >= 20% above prior year and GBP profile clicks have not dropped >= 15% from peak.",
    };
  }
  // Default: holding pattern
  // If tier is GREEN, lean slightly emerald-neutral; otherwise zinc.
  return {
    prefix: "— Holding",
    text: "metrics roughly tracking prior period",
    tone: tier === "GREEN" ? "emerald" : "zinc",
    explainer:
      "No flag conditions met, and no clear strong-trajectory signal. Metrics within normal range vs. prior period.",
  };
}

function HeadlineBar({ headline }: { headline: HeadlineShape }) {
  const toneClass =
    headline.tone === "rose"
      ? "bg-zoca-pink/12 text-zoca-pink-bright border-zoca-pink/25"
      : headline.tone === "emerald"
        ? "bg-emerald-500/12 text-emerald-700 border-emerald-500/25"
        : "bg-zoca-bg-tint text-zoca-text-2 border-zoca-border";
  return (
    <div
      className={`mb-3 flex items-center gap-2 rounded-zoca border px-2.5 py-1.5 text-[12px] font-medium ${toneClass}`}
      role="status"
    >
      <span className="font-semibold tabular-nums">{headline.prefix}</span>
      <span className="opacity-70">—</span>
      <span className="leading-snug">{headline.text}</span>
      <span
        aria-hidden
        className="ml-auto cursor-help text-[11px] opacity-60 hover:opacity-100"
        title={`How we computed this: ${headline.explainer}`}
      >
        ⓘ
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section label (Phase 26)
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zoca-text-2">
      {children}
    </div>
  );
}

function Subtitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] italic text-zoca-text-3 leading-tight">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function V2PerformancePanel({ performance, tier }: Props) {
  if (!performance) {
    return (
      <div className="mt-3 rounded-zoca border border-dashed border-zoca-border bg-zoca-bg-tint px-3 py-2 text-[11px] text-zoca-text-2">
        Performance signals unavailable for this entity (no Metabase row).
      </div>
    );
  }

  const p = performance;
  // Infer tier when not passed: flagged => RED, otherwise zinc-neutral.
  const effectiveTier: Tier =
    tier ?? (p.flag ? "RED" : "GREEN");
  const headline = computeHeadline(p, effectiveTier);

  // GBP clicks "drop_pct" is stored as a positive number meaning "% down from peak".
  // For the inline arrow we want a signed direction: negative if dropped, neutral
  // if flat. Convert: if drop_pct > 0, treat as a -drop_pct movement for the arrow.
  const gbpDirection =
    p.gbp_clicks_drop_pct === null ? null : -p.gbp_clicks_drop_pct;

  return (
    <div
      className="mt-3 rounded-zoca border border-zoca-border bg-zoca-bg-tint px-4 py-3.5"
      style={{
        // Phase 33.brand-watchfire-T8 — inset highlight Light Parchment.
        boxShadow: "inset 0 1px 0 rgba(248, 239, 215, 0.7)",
      }}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zoca-text-2">
          Performance signals
        </h4>
        {p.flag && (
          <span
            className="rounded-zoca-pill bg-zoca-pink/18 px-2 py-0.5 text-[10px] font-semibold text-zoca-pink-bright"
            title={p.flag_reasons.join(" · ") || "Performance trajectory flagged"}
          >
            ⚑ Trajectory concern
          </span>
        )}
      </div>

      {/* Trajectory headline — one-sentence summary */}
      <HeadlineBar headline={headline} />

      {/* Visibility & Demand */}
      <SectionLabel>Visibility & Demand</SectionLabel>
      <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 text-[12px]">
        {/* GBP profile clicks */}
        <dt
          className="text-zoca-text-2"
          title="How many times your Google Business Profile listing was clicked. We compare the latest complete month against the peak complete month — partial months are tracked separately."
        >
          GBP clicks
        </dt>
        <dd className="flex flex-col gap-0.5 text-zoca-text-2">
          <div className="flex items-center gap-2">
            <InlineArrow value={gbpDirection} lowerIsBetter={false} />
            <span
              className="font-medium tabular-nums text-zoca-text"
              title="Current complete month"
            >
              {formatNumber(p.gbp_clicks_current_complete_month)}
            </span>
            <span className="text-zoca-text-2" aria-hidden>
              /
            </span>
            <span
              className="text-zoca-text-2 tabular-nums"
              title="Peak complete month"
            >
              peak {formatNumber(p.gbp_clicks_peak_complete_month)}
            </span>
            {p.gbp_clicks_in_progress_month !== null && (
              <span
                className="text-[10px] text-zoca-text-2 tabular-nums"
                title="In-progress month (partial — not used for peak/dip)"
              >
                · running {formatNumber(p.gbp_clicks_in_progress_month)}
              </span>
            )}
          </div>
          <Subtitle>How many times your Google listing was clicked</Subtitle>
        </dd>
        <dd className="text-right">
          <PctBadge
            value={p.gbp_clicks_drop_pct === null ? null : -p.gbp_clicks_drop_pct}
            lowerIsBetter={false}
            title="GBP profile-click change from peak complete month to current complete month"
          />
        </dd>

        {/* Keyword rankings */}
        <dt
          className="text-zoca-text-2"
          title="Active keyword rankings from local SEO tracking. Distribution shows how many keywords sit in the top-3, top-10, and outside the top-10."
        >
          Keywords
        </dt>
        <dd className="flex flex-col gap-0.5 text-zoca-text-2">
          <div className="flex items-center gap-2">
            <span
              className="font-medium tabular-nums text-zoca-text"
              title="Total active rankings"
            >
              {formatNumber(p.active_ranking_count)}
            </span>
            <DistributionBar
              top3={p.rankings_top_3}
              top10={p.rankings_top_10}
              outside={p.rankings_outside_10}
            />
            <span className="text-[10px] text-zoca-text-2 tabular-nums">
              <span className="text-emerald-700">{p.rankings_top_3 ?? 0}</span> /{" "}
              <span className="text-amber-700">{p.rankings_top_10 ?? 0}</span> /{" "}
              <span className="text-zoca-pink-bright">{p.rankings_outside_10 ?? 0}</span>
            </span>
          </div>
          <Subtitle>Local search terms you're ranking for</Subtitle>
        </dd>
        <dd className="text-right text-[10px] text-zoca-text-2">top-3 / top-10 / out</dd>
      </dl>

      {/* Divider */}
      <div className="mt-3 mb-1 border-t border-zoca-border/60" aria-hidden />

      {/* Conversion */}
      <SectionLabel>Conversion</SectionLabel>
      <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 text-[12px]">
        {/* Reviews 12w */}
        <dt
          className="text-zoca-text-2"
          title="New reviews captured in the last 12 weeks. Aim for the weekly review target — zero-review weeks are an early warning sign."
        >
          Reviews 12w
        </dt>
        <dd className="flex flex-col gap-0.5 text-zoca-text-2">
          <div className="flex items-center gap-2">
            <span
              className="font-medium tabular-nums text-zoca-text"
              title="Reviews in last 12 weeks"
            >
              {formatNumber(p.reviews_last_12_weeks_total)}
            </span>
            {p.weeks_with_zero_reviews !== null && p.weeks_with_zero_reviews > 0 && (
              <span
                className={`text-[10px] tabular-nums ${
                  p.weeks_with_zero_reviews >= 4 ? "text-zoca-pink-bright" : "text-zoca-text-2"
                }`}
                title={`${p.weeks_with_zero_reviews} weeks with no reviews collected`}
              >
                · {p.weeks_with_zero_reviews}wk zero
              </span>
            )}
            {p.review_target_weekly !== null && (
              <span
                className="text-[10px] text-zoca-text-2 tabular-nums"
                title="Recommended weekly review target"
              >
                · target {formatNumber(p.review_target_weekly)}/wk
              </span>
            )}
          </div>
          <Subtitle>New reviews captured in last 12 weeks</Subtitle>
        </dd>
        <dd />

        {/* YTD leads */}
        <dt
          className="text-zoca-text-2"
          title="Year-to-date booking enquiries from Google Business Profile, compared to the same period last year. A healthy salon should see this trending up."
        >
          YTD leads
        </dt>
        <dd className="flex flex-col gap-0.5 text-zoca-text-2">
          <div className="flex items-center gap-2">
            <InlineArrow value={p.ytd_leads_change_pct} lowerIsBetter={false} />
            <span
              className="font-medium tabular-nums text-zoca-text"
              title="YTD leads"
            >
              {formatNumber(p.ytd_leads)}
            </span>
            {p.prior_ytd_leads !== null && (
              <span
                className="text-[10px] text-zoca-text-2 tabular-nums"
                title="Prior-year YTD leads"
              >
                · prior {formatNumber(p.prior_ytd_leads)}
              </span>
            )}
          </div>
          <Subtitle>Booking enquiries this year via GBP</Subtitle>
        </dd>
        <dd className="text-right">
          <PctBadge
            value={p.ytd_leads_change_pct}
            lowerIsBetter={false}
            title="YTD lead-count change vs prior year"
          />
        </dd>
      </dl>

      {p.flag && p.flag_reasons.length > 0 && (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-zoca-pink-bright/80 hover:text-zoca-pink-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40">
            Why flagged? ({p.flag_reasons.length})
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-zoca-text-2">
            {p.flag_reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
