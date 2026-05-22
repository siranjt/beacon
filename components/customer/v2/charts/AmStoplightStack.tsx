"use client";

// ---------------------------------------------------------------------------
// Phase 23.B — per-AM stoplight stacked bar.
//
// One column per AM with three stacked segments: RED / Yellow / Green.
// Click any column → /customer?am=<AM>&filter=act (opens that AM's planner
// filtered to RED) and surfaces a toast confirmation.
//
// Reuses Phase 22's AnimatedNumber + Toast and the shared chart-theme so
// the entrance cadence + tooltip styling matches every Phase-22/23 chart.
// ---------------------------------------------------------------------------

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

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

export type AmStoplightRow = {
  am: string;
  red: number;
  yellow: number;
  green: number;
};

type Props = {
  rows: AmStoplightRow[];
};

export function AmStoplightStack({ rows }: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const totalRed = rows.reduce((s, r) => s + r.red, 0);

  const data = {
    labels: rows.map((r) => r.am.split(" ")[0]),
    datasets: [
      {
        label: "RED",
        data: rows.map((r) => r.red),
        backgroundColor: CHART_COLORS.red,
        borderRadius: 4,
        stack: "s",
        barThickness: 26,
      },
      {
        label: "Yellow",
        data: rows.map((r) => r.yellow),
        backgroundColor: CHART_COLORS.amber,
        borderRadius: 4,
        stack: "s",
        barThickness: 26,
      },
      {
        label: "Green",
        data: rows.map((r) => r.green),
        backgroundColor: CHART_COLORS.green,
        borderRadius: 4,
        stack: "s",
        barThickness: 26,
      },
    ],
  };

  const options = {
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
          title: (items: { dataIndex: number }[]) =>
            rows[items[0].dataIndex]?.am ?? "",
        },
      },
    },
    scales: {
      x: {
        stacked: true,
        ticks: {
          color: CHART_COLORS.midnight,
          font: { size: 11, weight: "500" as const },
        },
        grid: { display: false },
      },
      y: {
        stacked: true,
        ticks: { color: CHART_COLORS.muted, font: { size: 10 } },
        grid: { color: CHART_COLORS.gridLine },
      },
    },
    onClick: (_e: unknown, els: { index: number }[]) => {
      if (!els[0]) return;
      const idx = els[0].index;
      const row = rows[idx];
      if (!row) return;
      const params = new URLSearchParams();
      params.set("am", row.am);
      params.set("filter", "act");
      router.push(`/customer?${params.toString()}`);
      showToast(`Opening ${row.am.split(" ")[0]}'s Beacon - ${row.red} RED`, {
        type: "info",
        icon: "user",
      });
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
    <div className="zoca-card" style={{ padding: "16px 18px" }}>
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
        Per-AM stoplight composition
      </div>
      <div
        style={{
          fontSize: "11px",
          color: CHART_COLORS.muted,
          marginBottom: "10px",
        }}
      >
        <AnimatedNumber value={totalRed} /> RED across{" "}
        <AnimatedNumber value={rows.length} /> AMs - click bar to open
      </div>
      <div
        style={{
          display: "flex",
          gap: "14px",
          marginBottom: "8px",
          fontSize: "11px",
          color: CHART_COLORS.muted,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: CHART_COLORS.red,
            }}
          ></span>
          RED
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: CHART_COLORS.amber,
            }}
          ></span>
          Yellow
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: CHART_COLORS.green,
            }}
          ></span>
          Green
        </span>
      </div>
      <div style={{ position: "relative", width: "100%", height: "240px" }}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Bar data={data} options={options as any} />
      </div>
    </div>
  );
}
