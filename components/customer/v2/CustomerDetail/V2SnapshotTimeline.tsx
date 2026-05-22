"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (1 hex/rgba + 5 tailwind-rose swept)

// ---------------------------------------------------------------------------
// Phase 30 — Snapshot timeline chart.
//
// Per-customer composite-score timeseries with rich overlays:
//   - stoplight tier bands behind the line (RED / YELLOW / GREEN)
//   - vertical scatter markers at each logged AM action, color-coded by type
//   - gray shaded ranges for snooze windows
//   - thin dashed verticals at stoplight transitions
//
// Two variants:
//   - inline: ~140px tall, no axis labels — drops into the customer-detail
//             header, replacing the tiny sparkline
//   - full:   ~480px tall, full axes, time-range pill toggle (7/30/90),
//             icon legend — drives the standalone /customer/customer/[id]/timeline
//             page
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState, useCallback } from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  LineController,
  ScatterController,
  Filler,
  Tooltip,
  Legend,
  type ChartOptions,
  type ChartData,
  type Plugin,
  type TooltipItem,
} from "chart.js";
import {
  CHART_COLORS,
  CHART_ANIMATION,
  CHART_TOOLTIP_STYLE,
} from "@/lib/customer/chart-theme";
import { TIER_CUTS } from "@/lib/customer/config";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  LineController,
  ScatterController,
  Filler,
  Tooltip,
  Legend,
);

type StoplightT = "RED" | "YELLOW" | "GREEN";

type TimelineComposite = {
  date: string;
  composite: number;
  stoplight: StoplightT;
};

type TimelineAction = {
  id: number;
  date: string;
  iso: string;
  am_name: string;
  action_type: string;
  reason_code: string | null;
  note: string | null;
  composite_at_action: number | null;
};

type TimelineSnooze = {
  snoozed_at: string;
  snoozed_until: string;
  am_name: string;
  reason: string | null;
};

type TimelineTransition = {
  date: string;
  from: StoplightT;
  to: StoplightT;
};

type TimelineResponse = {
  ok: boolean;
  entity_id: string;
  days: number;
  generated_at: string;
  composite_series: TimelineComposite[];
  actions: TimelineAction[];
  snooze_ranges: TimelineSnooze[];
  stoplight_transitions: TimelineTransition[];
  error?: string;
};

type Variant = "inline" | "full";
type DaysOpt = 7 | 30 | 90;

type Props = {
  entityId: string;
  variant: Variant;
  days?: DaysOpt;
  onDaysChange?: (days: DaysOpt) => void;
  bizname?: string;
};

// Action-type colors (matching the dashboard's V2ActionLogPanel palette).
const ACTION_COLORS: Record<string, string> = {
  contacted_connected: "#10b981", // emerald
  contacted_vm:        "#f59e0b", // amber
  contacted_noreach:   "#f43f5e", // rose
  escalated:           "#0ea5e9", // sky
};

const ACTION_LABELS: Record<string, string> = {
  contacted_connected: "Connected",
  contacted_vm:        "Voicemail",
  contacted_noreach:   "No reach",
  escalated:           "Escalated",
};

function actionLabel(t: string): string {
  return ACTION_LABELS[t] || t;
}

function actionColor(t: string): string {
  return ACTION_COLORS[t] || CHART_COLORS.purple;
}

function formatLabel(yyyyMmDd: string): string {
  // Convert "2026-05-14" → "May 14" — robust to TZ since we slice strings.
  if (!yyyyMmDd || yyyyMmDd.length < 10) return yyyyMmDd;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const m = Number(yyyyMmDd.slice(5, 7));
  const d = Number(yyyyMmDd.slice(8, 10));
  if (!Number.isFinite(m) || !Number.isFinite(d)) return yyyyMmDd;
  return `${months[m - 1]} ${d}`;
}

/**
 * Pick the closest composite point for a given date, used to position
 * action-marker scatter points on the y-axis when composite_at_action is null.
 */
function interpolateComposite(
  series: TimelineComposite[],
  date: string,
): number {
  if (!series.length) return 0;
  let best = series[0];
  for (const p of series) {
    if (p.date <= date) best = p;
    else break;
  }
  return best.composite;
}

// ---------------------------------------------------------------------------
// Custom plugin for the overlay layer (stoplight bands, snooze rects,
// transition gridlines). Reads its config off chart.options.plugins.
// ---------------------------------------------------------------------------

type OverlayConfig = {
  snooze_ranges: TimelineSnooze[];
  stoplight_transitions: TimelineTransition[];
  labels: string[];   // pre-formatted x-axis labels, indexed by series position
  iso_dates: string[]; // YYYY-MM-DD per label so we can match by date
  show_bands: boolean;
};

const overlayPlugin: Plugin<"line"> = {
  id: "snapshotTimelineOverlay",
  beforeDatasetsDraw(chart) {
    const cfg = (
      chart.options.plugins as unknown as {
        snapshotTimelineOverlay?: OverlayConfig;
      }
    )?.snapshotTimelineOverlay;
    if (!cfg) return;

    const { ctx, chartArea } = chart;
    const yScale = chart.scales.y;
    const xScale = chart.scales.x;
    if (!yScale || !xScale) return;

    const { left, right, top, bottom } = chartArea;

    // 1) Stoplight tier bands — RED (>=65), YELLOW (35..64), GREEN (<35).
    if (cfg.show_bands) {
      // Clamp band edges to chart area.
      const yRedTop = yScale.getPixelForValue(100);
      const yRedBot = yScale.getPixelForValue(TIER_CUTS.high);     // 65
      const yYellowTop = yRedBot;
      const yYellowBot = yScale.getPixelForValue(TIER_CUTS.medium); // 35
      const yGreenTop = yYellowBot;
      const yGreenBot = yScale.getPixelForValue(0);

      ctx.save();
      ctx.fillStyle = "rgba(244,63,94,0.06)";
      ctx.fillRect(left, yRedTop, right - left, yRedBot - yRedTop);
      ctx.fillStyle = "rgba(245,158,11,0.06)";
      ctx.fillRect(left, yYellowTop, right - left, yYellowBot - yYellowTop);
      ctx.fillStyle = "rgba(16,185,129,0.06)";
      ctx.fillRect(left, yGreenTop, right - left, yGreenBot - yGreenTop);
      ctx.restore();
    }

    // Helper: map an ISO datetime / YYYY-MM-DD to an x-pixel by finding the
    // closest label in iso_dates. Returns null if outside the series range.
    const xForIso = (iso: string): number | null => {
      if (!iso || !cfg.iso_dates.length) return null;
      const date = iso.slice(0, 10);
      // Find first index whose label-date is >= date.
      let idx = -1;
      for (let i = 0; i < cfg.iso_dates.length; i++) {
        if (cfg.iso_dates[i] >= date) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        // After series end → clamp to end.
        idx = cfg.iso_dates.length - 1;
      }
      const px = xScale.getPixelForValue(idx);
      if (!Number.isFinite(px)) return null;
      return px;
    };

    // 2) Snooze ranges — light gray rects spanning x = snoozed_at..snoozed_until
    for (const sn of cfg.snooze_ranges) {
      const xStart = xForIso(sn.snoozed_at);
      const xEnd = xForIso(sn.snoozed_until);
      if (xStart === null || xEnd === null) continue;
      const x0 = Math.max(left, Math.min(xStart, xEnd));
      const x1 = Math.min(right, Math.max(xStart, xEnd));
      if (x1 <= x0) continue;
      ctx.save();
      ctx.fillStyle = "rgba(100,116,139,0.10)";
      ctx.fillRect(x0, top, x1 - x0, bottom - top);
      // Subtle bottom rule to mark snooze span
      ctx.strokeStyle = "rgba(100,116,139,0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, bottom - 1);
      ctx.lineTo(x1, bottom - 1);
      ctx.stroke();
      ctx.restore();
    }

    // 3) Stoplight-transition dashed verticals
    if (cfg.stoplight_transitions.length) {
      ctx.save();
      ctx.strokeStyle = "rgba(11,5,29,0.20)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const tr of cfg.stoplight_transitions) {
        const x = xForIso(tr.date);
        if (x === null) continue;
        if (x < left || x > right) continue;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
      }
      ctx.restore();
    }
  },
};

// Register the overlay plugin once at module load.
ChartJS.register(overlayPlugin);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function V2SnapshotTimeline({
  entityId,
  variant,
  days = 90,
  onDaysChange,
  bizname,
}: Props) {
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/v2/customer/${encodeURIComponent(entityId)}/timeline?days=${days}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as TimelineResponse;
        if (cancelled) return;
        if (!json.ok) {
          setError(json.error || "Signal lost — couldn't load timeline");
          setData(null);
        } else {
          setData(json);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityId, days, retryNonce]);

  const retry = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  // Chart data + options memo
  const chartViewModel = useMemo(() => {
    if (!data) return null;
    const series = data.composite_series;
    const labels = series.map((p) => formatLabel(p.date));
    const isoDates = series.map((p) => p.date);
    const values = series.map((p) => p.composite);

    // Scatter markers — one point per action. We re-use CategoryScale so the
    // x-value must be a label string. Snap each action to the nearest label
    // (by date).
    const actionPoints = data.actions.map((a) => {
      // find index of closest date in series
      let idx = -1;
      for (let i = 0; i < isoDates.length; i++) {
        if (isoDates[i] >= a.date) {
          idx = i;
          break;
        }
      }
      if (idx === -1) idx = isoDates.length - 1;
      if (idx < 0) idx = 0;
      const labelStr = labels[idx] ?? "";
      const composite =
        a.composite_at_action !== null
          ? a.composite_at_action
          : interpolateComposite(series, a.date);
      return {
        x: labelStr,
        y: composite,
        // Tucked under index for tooltip callbacks
        _meta: a,
      };
    });

    return { labels, isoDates, values, actionPoints };
  }, [data]);

  const heightPx = variant === "full" ? 480 : 140;

  if (loading) {
    return (
      <div
        className="bg-zoca-bg-tint animate-pulse rounded-zoca"
        style={{ height: heightPx }}
        aria-busy="true"
      />
    );
  }

  if (error) {
    return (
      <div
        className="flex items-center justify-between rounded-zoca border border-zoca-pink/60 bg-zoca-pink-soft px-3 py-2 text-[12px] text-zoca-pink-bright"
        style={{ minHeight: heightPx }}
      >
        <span>Signal lost · {error}</span>
        <button
          type="button"
          onClick={retry}
          className="ml-3 rounded-zoca-pill border border-rose-300 bg-zoca-bg-soft px-2 py-0.5 text-[11px] font-medium text-zoca-pink-bright hover:bg-zoca-pink-soft"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data || !chartViewModel || chartViewModel.values.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-zoca border border-zoca-border bg-zoca-bg-tint text-[12px] text-zoca-text-2"
        style={{ height: heightPx }}
      >
        No snapshot history yet — check back tomorrow.
      </div>
    );
  }

  const { labels, isoDates, values, actionPoints } = chartViewModel;

  const chartData = {
    labels,
    datasets: [
      {
        type: "line" as const,
        label: "Composite",
        data: values,
        borderColor: CHART_COLORS.red,
        backgroundColor: "rgba(200, 67, 29, 0.10)",
        fill: false,
        tension: 0.25,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 3,
        pointBackgroundColor: CHART_COLORS.red,
        pointBorderColor: "#ffffff",
        pointBorderWidth: 2,
      },
      {
        type: "scatter" as const,
        label: "Actions",
        data: actionPoints,
        showLine: false,
        pointRadius: 5,
        pointHoverRadius: 7,
        pointBackgroundColor: actionPoints.map((p) =>
          actionColor(
            (p as unknown as { _meta: TimelineAction })._meta.action_type,
          ),
        ),
        pointBorderColor: "#ffffff",
        pointBorderWidth: 2,
      },
    ],
  };

  const overlayConfig: OverlayConfig = {
    snooze_ranges: data.snooze_ranges,
    stoplight_transitions: data.stoplight_transitions,
    labels,
    iso_dates: isoDates,
    show_bands: true,
  };

  const options: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: CHART_ANIMATION.duration,
      easing: CHART_ANIMATION.easing,
    },
    interaction: {
      mode: "nearest",
      intersect: false,
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...CHART_TOOLTIP_STYLE,
        callbacks: {
          title: (items: TooltipItem<"line">[]) => {
            if (!items.length) return "";
            const it = items[0];
            // If hovering a composite-line point, show the label date.
            if (it.datasetIndex === 0) {
              const idx = it.dataIndex;
              return isoDates[idx] || labels[idx] || "";
            }
            // Otherwise (action scatter) read date from the action meta.
            const raw = it.raw as
              | { x: string; y: number; _meta?: TimelineAction }
              | undefined;
            return raw?._meta?.date ?? "";
          },
          label: (it: TooltipItem<"line">) => {
            if (it.datasetIndex === 0) {
              const idx = it.dataIndex;
              const comp = values[idx];
              const sl = data.composite_series[idx]?.stoplight ?? "";
              return `Composite ${comp} · ${sl}`;
            }
            const raw = it.raw as
              | { x: string; y: number; _meta?: TimelineAction }
              | undefined;
            const m = raw?._meta;
            if (!m) return "";
            const lbl = actionLabel(m.action_type);
            const by = m.am_name ? ` by ${m.am_name}` : "";
            const reason = m.reason_code ? ` · ${m.reason_code}` : "";
            return `${lbl}${by}${reason}`;
          },
          afterLabel: (it: TooltipItem<"line">) => {
            if (it.datasetIndex !== 1) return "";
            const raw = it.raw as
              | { x: string; y: number; _meta?: TimelineAction }
              | undefined;
            const note = raw?._meta?.note;
            if (!note) return "";
            const trimmed = note.length > 90 ? `${note.slice(0, 87)}…` : note;
            return trimmed;
          },
        },
      },
      // Custom plugin payload (typed via cast).
      ...({
        snapshotTimelineOverlay: overlayConfig,
      } as unknown as Record<string, unknown>),
    },
    scales: {
      x: {
        type: "category",
        grid: { display: false },
        ticks: {
          display: variant === "full",
          color: CHART_COLORS.muted,
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: variant === "full" ? 10 : 6,
          font: { size: 10 },
        },
      },
      y: {
        min: 0,
        max: 100,
        grid: {
          color: CHART_COLORS.gridLine,
          display: variant === "full",
        },
        ticks: {
          display: variant === "full",
          color: CHART_COLORS.muted,
          font: { size: 10 },
          stepSize: 25,
        },
      },
    },
  };

  // For "inline" we render only the chart with a small caption underneath.
  // For "full" we render a pill toggle + a legend chip row above the chart.
  const trendDirection = (() => {
    if (values.length < 2) return "";
    const first = values[0];
    const last = values[values.length - 1];
    if (last < first - 2) return "improving";
    if (last > first + 2) return "worsening";
    return "stable";
  })();

  return (
    <div className="w-full">
      {variant === "full" && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3 text-[11px] text-zoca-text-2">
            <LegendKey />
          </div>
          <div className="flex items-center gap-1 rounded-zoca-pill border border-zoca-border bg-zoca-bg-soft p-0.5">
            {[7, 30, 90].map((n) => {
              const active = days === n;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => onDaysChange?.(n as DaysOpt)}
                  className={
                    active
                      ? "rounded-zoca-pill bg-zoca-pink-cta px-2.5 py-1 text-[11px] font-semibold text-white"
                      : "rounded-zoca-pill px-2.5 py-1 text-[11px] font-medium text-zoca-text-2 hover:bg-zoca-bg-tint"
                  }
                  aria-pressed={active}
                >
                  {n}d
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div
        className="relative w-full"
        style={{ height: heightPx }}
        title={bizname ? `${bizname} — composite timeline` : undefined}
      >
        <Line
          data={chartData as unknown as ChartData<"line">}
          options={options}
        />
      </div>

      {variant === "inline" && (
        <div className="mt-1 text-[10px] text-zoca-text-2 tabular-nums">
          Last {data.days}d
          {trendDirection ? ` · ${trendDirection}` : ""}
          {data.actions.length
            ? ` · ${data.actions.length} action${data.actions.length === 1 ? "" : "s"}`
            : ""}
          {data.snooze_ranges.length
            ? ` · ${data.snooze_ranges.length} snooze${data.snooze_ranges.length === 1 ? "" : "s"}`
            : ""}
        </div>
      )}
    </div>
  );
}

function LegendKey() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-zoca-text-2">
      <span className="inline-flex items-center gap-1">
        <span
          aria-hidden
          className="inline-block h-[2px] w-4 rounded-full"
          style={{ background: CHART_COLORS.red }}
        />
        Composite
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: "#10b981" }}
        />
        Action
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          aria-hidden
          className="inline-block h-3 w-3 rounded-sm"
          style={{ background: "rgba(100,116,139,0.30)" }}
        />
        Snooze
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          aria-hidden
          className="inline-block h-3 w-[2px]"
          style={{
            background:
              "repeating-linear-gradient(to bottom, rgba(11,5,29,0.4) 0 3px, transparent 3px 6px)",
          }}
        />
        Transition
      </span>
    </div>
  );
}

export default V2SnapshotTimeline;
