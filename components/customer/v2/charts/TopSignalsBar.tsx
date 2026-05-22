"use client";

// ---------------------------------------------------------------------------
// Phase 23.B — top signals horizontal bar.
//
// Counts customers across the entire team carrying each signal (via the
// shared customerHasSignal predicate from Phase 22.B.1) and renders the
// top 5 as a horizontal bar chart. Click any bar → /customer?signal=<key>
// (team-wide drill — no AM scope) with toast confirmation.
// ---------------------------------------------------------------------------

import { useMemo } from "react";
import { Bar } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
} from "chart.js";
import { useRouter } from "next/navigation";
import { useToast } from "../Toast";
import {
  CHART_COLORS,
  CHART_ANIMATION,
  CHART_TOOLTIP_STYLE,
} from "@/lib/customer/chart-theme";
import { AnimatedNumber } from "../AnimatedNumber";
import {
  SIGNAL_LABELS,
  customerHasSignal,
  type SignalKey,
} from "@/lib/customer/signal-taxonomy";
import type { ScoredCustomerV2 } from "@/lib/customer/types";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

// Phase 33.brand-watchfire — signal colors per spec §7.
const SIGNAL_COLORS: Record<SignalKey, string> = {
  client_silent: CHART_COLORS.red,      // Ember
  we_silent: CHART_COLORS.rose,         // Ember @ 55%
  resp_drop: CHART_COLORS.amber,        // Brass
  vol_collapse: CHART_COLORS.blue,      // Sea Lapis
  usage_low: CHART_COLORS.muted,        // Smoke
  billing: CHART_COLORS.midnight,       // Char
  perf_flag: CHART_COLORS.midnight,     // Char (combined w/ billing)
};

const ALL_SIGNALS: SignalKey[] = [
  "client_silent",
  "we_silent",
  "resp_drop",
  "vol_collapse",
  "usage_low",
  "billing",
  "perf_flag",
];

type Props = {
  customers: ScoredCustomerV2[];
};

export function TopSignalsBar({ customers }: Props) {
  const router = useRouter();
  const { showToast } = useToast();

  const top = useMemo(() => {
    const counts = ALL_SIGNALS.map((key) => {
      let n = 0;
      for (const c of customers) {
        if (customerHasSignal(c, key)) n += 1;
      }
      return { key, count: n };
    });
    return counts
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [customers]);

  const totalFlagged = top.reduce((s, r) => s + r.count, 0);

  const data = {
    labels: top.map((r) => SIGNAL_LABELS[r.key]),
    datasets: [
      {
        label: "Customers",
        data: top.map((r) => r.count),
        backgroundColor: top.map((r) => SIGNAL_COLORS[r.key]),
        borderRadius: 6,
        barThickness: 22,
      },
    ],
  };

  const options = {
    indexAxis: "y" as const,
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: CHART_ANIMATION.duration,
      easing: CHART_ANIMATION.easing,
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...CHART_TOOLTIP_STYLE,
        callbacks: {
          label: (ctx: { parsed: { x: number }; label: string }) =>
            `${ctx.label}: ${ctx.parsed.x} customer${ctx.parsed.x === 1 ? "" : "s"}`,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: CHART_COLORS.muted, font: { size: 10 }, precision: 0 },
        grid: { color: CHART_COLORS.gridLine },
        beginAtZero: true,
      },
      y: {
        ticks: {
          color: CHART_COLORS.midnight,
          font: { size: 11, weight: "500" as const },
        },
        grid: { display: false },
      },
    },
    onClick: (_e: unknown, els: { index: number }[]) => {
      if (!els[0]) return;
      const idx = els[0].index;
      const row = top[idx];
      if (!row) return;
      const params = new URLSearchParams();
      params.set("signal", row.key);
      router.push(`/customer?${params.toString()}`);
      showToast(
        `Filtered team-wide to ${SIGNAL_LABELS[row.key]} - ${row.count} customers`,
        { type: "info", icon: "filter" },
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
          fontSize: "10px",
          color: CHART_COLORS.muted,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          fontWeight: 600,
          marginBottom: "4px",
        }}
      >
        Top signals (team)
      </div>
      <div
        style={{
          fontSize: "11px",
          color: CHART_COLORS.muted,
          marginBottom: "10px",
        }}
      >
        <AnimatedNumber value={totalFlagged} /> customer-signals across top{" "}
        <AnimatedNumber value={top.length} /> - click to drill
      </div>
      <div style={{ position: "relative", width: "100%", height: "200px" }}>
        {top.length === 0 ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "11px",
              color: CHART_COLORS.muted,
            }}
          >
            No active signals across team
          </div>
        ) : (
          <Bar data={data} options={options as any} />
        )}
      </div>
    </div>
  );
}
