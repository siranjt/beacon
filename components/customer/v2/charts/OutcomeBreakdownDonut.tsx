"use client";

// ---------------------------------------------------------------------------
// Phase 23.B — 7-day team-wide outcome donut.
//
// Aggregates AM action outcomes from /api/v2/am-activity (Phase 15.2) into a
// team-level breakdown: Re-engaged / Connected / VM / No reach / Escalated.
// Same visual spec as BookHealthDonut (cutout 62%, hoverOffset, brand
// colors). Click slice → toast indicating the outcome count (no navigation
// — manager-level outcome list doesn't have a deep-link target yet).
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { Doughnut } from "react-chartjs-2";
import {
  Chart as ChartJS,
  ArcElement,
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

ChartJS.register(ArcElement, Tooltip, Legend);

type AmOutcomeRow = {
  am_name: string;
  actions_total: number;
  connected: number;
  voicemail: number;
  no_reach: number;
  escalated: number;
  re_engaged: number;
};

type Props = {
  daysBack?: number;
};

const SLICE_DEFS = [
  { key: "re_engaged", label: "Re-engaged", color: CHART_COLORS.green },
  { key: "connected", label: "Connected", color: CHART_COLORS.blue },
  { key: "voicemail", label: "VM", color: CHART_COLORS.purple },
  { key: "no_reach", label: "No reach", color: CHART_COLORS.muted },
  { key: "escalated", label: "Escalated", color: CHART_COLORS.red },
] as const;

export function OutcomeBreakdownDonut({ daysBack = 7 }: Props) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<AmOutcomeRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v2/am-activity?days=${daysBack}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setLoading(false);
          return;
        }
        const json = (await res.json()) as { rows?: AmOutcomeRow[] };
        if (cancelled) return;
        setRows(json.rows || []);
      } catch {
        /* swallow — empty state will render */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [daysBack]);

  const totals = useMemo(() => {
    const out = { re_engaged: 0, connected: 0, voicemail: 0, no_reach: 0, escalated: 0 };
    for (const r of rows) {
      out.re_engaged += r.re_engaged || 0;
      out.connected += r.connected || 0;
      out.voicemail += r.voicemail || 0;
      out.no_reach += r.no_reach || 0;
      out.escalated += r.escalated || 0;
    }
    return out;
  }, [rows]);

  const totalActions =
    totals.re_engaged + totals.connected + totals.voicemail + totals.no_reach + totals.escalated;

  const data = {
    labels: SLICE_DEFS.map((s) => s.label),
    datasets: [
      {
        data: SLICE_DEFS.map((s) => totals[s.key as keyof typeof totals]),
        backgroundColor: SLICE_DEFS.map((s) => s.color),
        borderWidth: 2,
        borderColor: CHART_COLORS.bg,
        hoverBorderWidth: 3,
        hoverOffset: 6,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: "62%",
    animation: {
      animateRotate: true,
      duration: CHART_ANIMATION.duration,
      easing: CHART_ANIMATION.easing,
    },
    plugins: {
      legend: { display: false },
      tooltip: CHART_TOOLTIP_STYLE,
    },
    onClick: (_e: unknown, els: { index: number }[]) => {
      if (!els[0]) return;
      const idx = els[0].index;
      const slice = SLICE_DEFS[idx];
      const count = totals[slice.key as keyof typeof totals];
      showToast(
        `${count} customers contacted via ${slice.label} in last ${daysBack} days`,
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
        7-day team outcomes
      </div>
      <div
        style={{
          fontSize: "11px",
          color: CHART_COLORS.muted,
          marginBottom: "10px",
        }}
      >
        <AnimatedNumber value={totalActions} /> actions logged
        {totalActions > 0 ? " - click slice for detail" : ""}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "8px 12px",
          marginBottom: "8px",
          fontSize: "11px",
          color: CHART_COLORS.muted,
        }}
      >
        {SLICE_DEFS.map((s) => (
          <span
            key={s.key}
            style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: s.color,
              }}
            ></span>
            {s.label}{" "}
            <strong style={{ color: CHART_COLORS.midnight, fontWeight: 600 }}>
              <AnimatedNumber value={totals[s.key as keyof typeof totals]} />
            </strong>
          </span>
        ))}
      </div>
      <div style={{ position: "relative", width: "100%", height: "180px" }}>
        {totalActions === 0 ? (
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
            {loading ? "Catching signals…" : `No actions logged in last ${daysBack} days`}
          </div>
        ) : (
          /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
          <Doughnut data={data} options={options as any} />
        )}
      </div>
    </div>
  );
}
