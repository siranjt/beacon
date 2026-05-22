"use client";

// ---------------------------------------------------------------------------
// Phase 23.A — 30-day RED trend line.
//
// Pulls per-day RED counts from /api/v2/am/:amName/trend?days=30 (backed
// by readAmBookTrend over the flat customer_trends table). If the API
// returns < 2 points (cold-start, first week of deploy, etc.) we fall
// back to a deterministic placeholder series anchored on `currentRed`
// with bounded daily variance so the chart still renders.
//
// Click a point -> toast announcing the snapshot from D-N. Hover -> tooltip
// shows the count. Same 1100ms ease-out cubic animation as Phase 22.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
} from "chart.js";
import { useToast } from "../Toast";
import {
  CHART_COLORS,
  CHART_ANIMATION,
  CHART_TOOLTIP_STYLE,
} from "@/lib/customer/chart-theme";
import { AnimatedNumber } from "../AnimatedNumber";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
);

// Phase 33.brand-watchfire-PR6-final — current-point Ember halo per spec §11 row 26.
// Draws a halo behind the last data point that pulses 1.5s loop. Runs on every
// requestAnimationFrame after the entry animation settles (~2s in).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const emberTrendPulsePlugin: any = {
  id: "ember-trend-pulse",
  afterDatasetsDraw(chart: any) {
    const meta = chart.getDatasetMeta?.(0);
    const points = meta?.data;
    if (!points || points.length === 0) return;
    const last = points[points.length - 1];
    if (!last || typeof last.x !== "number" || typeof last.y !== "number") return;

    if (chart.$emberHaloStart == null) {
      chart.$emberHaloStart = performance.now();
    }
    const elapsed = performance.now() - chart.$emberHaloStart - 2000; // wait for entry
    if (elapsed < 0) {
      // still in entry; schedule a redraw past the entry barrier so the loop kicks off
      requestAnimationFrame(() => chart.draw && chart.draw());
      return;
    }

    const phase = (elapsed % 1500) / 1500;       // 0 → 1 over 1.5s
    const radius = 4 + 6 * phase;
    const alpha = 0.55 * (1 - phase);

    const c = chart.ctx;
    c.save();
    c.beginPath();
    c.arc(last.x, last.y, radius, 0, Math.PI * 2);
    c.fillStyle = `rgba(200, 67, 29, ${alpha})`;
    c.fill();
    c.restore();

    requestAnimationFrame(() => chart.draw && chart.draw());
  },
};

type Props = {
  currentRed: number;
  amName: string;
};

type TrendPoint = { date: string; red: number };

type ApiResponse = {
  am_name: string;
  days: number;
  points: { date: string; red?: number }[];
};

// Deterministic placeholder series — used when snapshot history is too
// thin to chart. Anchored on the current RED count with +/-15% bounded
// variance driven by a string-hash so the curve is stable across renders
// for the same AM (no jitter on re-mount).
//
// TODO Phase 23.B: drop this fallback once customer_trends is at least
// 30 days deep for every active AM. Until then the chart still renders
// something realistic.
function placeholderSeries(currentRed: number, amName: string): TrendPoint[] {
  let hash = 0;
  for (let i = 0; i < amName.length; i++) {
    hash = (hash * 31 + amName.charCodeAt(i)) >>> 0;
  }
  const out: TrendPoint[] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const seed = (hash + i * 17) % 1000;
    const drift = ((seed / 1000) - 0.5) * 0.3; // +/-15%
    const trend = (29 - i) / 29 * 0.1; // 0 -> +10% by end
    const base = currentRed * (0.9 + trend + drift);
    out.push({
      date: d.toISOString().slice(0, 10),
      red: Math.max(0, Math.round(base)),
    });
  }
  // Pin the final point to the actual current red count.
  if (out.length) out[out.length - 1].red = currentRed;
  return out;
}

export function RedTrendLine({ currentRed, amName }: Props) {
  const { showToast } = useToast();
  const [series, setSeries] = useState<TrendPoint[]>(() =>
    placeholderSeries(currentRed, amName),
  );
  const [isPlaceholder, setIsPlaceholder] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!amName) return;
      try {
        const res = await fetch(
          `/api/v2/am/${encodeURIComponent(amName)}/trend?days=30`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as ApiResponse;
        if (cancelled) return;
        const pts = (json.points || [])
          .filter((p) => Number.isFinite(p.red))
          .map((p) => ({ date: p.date, red: p.red as number }));
        if (pts.length >= 2) {
          // Pad the front with the earliest real value if API returned
          // fewer than 30 points so the x-axis is always 30 long.
          const padded: TrendPoint[] = [];
          const need = 30 - pts.length;
          for (let i = 0; i < need; i++) padded.push(pts[0]);
          setSeries([...padded, ...pts]);
          setIsPlaceholder(false);
        }
      } catch {
        /* swallow — placeholder already set */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [amName]);

  // Keep placeholder synced if currentRed changes (AM switch before fetch
  // resolves) so the last point doesn't lag.
  useEffect(() => {
    if (isPlaceholder) setSeries(placeholderSeries(currentRed, amName));
  }, [currentRed, amName, isPlaceholder]);

  const { labels, values, peak, low } = useMemo(() => {
    const lbls = series.map((p, i) => {
      const dayAgo = series.length - 1 - i;
      return dayAgo === 0 ? "Today" : `D-${dayAgo}`;
    });
    const vals = series.map((p) => p.red);
    return {
      labels: lbls,
      values: vals,
      peak: vals.length ? Math.max(...vals) : 0,
      low: vals.length ? Math.min(...vals) : 0,
    };
  }, [series]);

  const data = {
    labels,
    datasets: [
      {
        label: "RED count",
        data: values,
        borderColor: CHART_COLORS.red,
        // Phase 33.brand-watchfire — Light Ember fill @ 70% per spec §7.
        backgroundColor: "rgba(252, 228, 214, 0.70)",
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: CHART_COLORS.red,
        pointBorderColor: CHART_COLORS.bg,
        pointBorderWidth: 2,
        // Phase 33.brand-watchfire-PR4-deferred — line stroke 1.8 per spec §7.
        borderWidth: 1.8,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    // Phase 33.brand-watchfire-PR6-final — 2s line-draw entry per spec §11 row 13/14.
    animation: {
      duration: 2000,
      easing: CHART_ANIMATION.easing,
    },
    plugins: {
      legend: { display: false },
      tooltip: CHART_TOOLTIP_STYLE,
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          color: CHART_COLORS.muted,
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 8,
          font: { size: 10 },
        },
      },
      y: {
        // Phase 33.brand-watchfire-PR4-deferred — Y-axis polish per spec §7.
        grid: { color: CHART_COLORS.gridLine, lineWidth: 0.5 },
        ticks: { color: "#8B7A66", font: { size: 9 } },
        beginAtZero: true,
      },
    },
    onClick: (_e: unknown, els: { index: number }[]) => {
      if (!els[0]) return;
      const idx = els[0].index;
      const dayAgo = series.length - 1 - idx;
      const value = values[idx];
      showToast(
        `Loaded snapshot from D-${dayAgo}, RED was ${value}`,
        { type: "info", icon: "info" },
      );
    },
    onHover: (
      e: { native?: { target?: HTMLElement } } | null,
      els: unknown[],
    ) => {
      if (e?.native?.target) {
        e.native.target.style.cursor = els[0] ? "pointer" : "default";
      }
    },
  } as const;

  return (
    <div
      className="zoca-card"
      style={{ padding: "14px 16px", display: "flex", flexDirection: "column" }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: "4px",
        }}
      >
        <div
          style={{
            fontSize: "10px",
            color: CHART_COLORS.muted,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          30-day ember trend
        </div>
        {isPlaceholder && (
          <div
            style={{
              fontSize: "9px",
              color: CHART_COLORS.muted,
              fontStyle: "italic",
            }}
          >
            placeholder - history filling
          </div>
        )}
      </div>
      <div
        style={{
          fontSize: "11px",
          color: CHART_COLORS.muted,
          marginBottom: "10px",
          display: "flex",
          gap: "14px",
        }}
      >
        <span>
          Peak{" "}
          <strong style={{ color: CHART_COLORS.midnight, fontWeight: 600 }}>
            <AnimatedNumber value={peak} />
          </strong>
        </span>
        <span>
          Low{" "}
          <strong style={{ color: CHART_COLORS.midnight, fontWeight: 600 }}>
            <AnimatedNumber value={low} />
          </strong>
        </span>
        <span>
          Today{" "}
          <strong style={{ color: CHART_COLORS.midnight, fontWeight: 600 }}>
            <AnimatedNumber value={currentRed} />
          </strong>
        </span>
      </div>
      <div style={{ position: "relative", width: "100%", height: "180px" }}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Line data={data} options={options as any} plugins={[emberTrendPulsePlugin]} />
        {/* Phase 33.brand-watchfire-PR6-final — area-fill breathe overlay per spec §11 row 27. */}
        <div className="beacon-trend-breath" aria-hidden />
      </div>
    </div>
  );
}
