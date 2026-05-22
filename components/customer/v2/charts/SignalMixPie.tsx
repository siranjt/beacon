"use client";

// ---------------------------------------------------------------------------
// Phase 23.A — signal mix pie.
//
// Counts how many customers in the current AM's visible list carry each
// signal (using the canonical `customerHasSignal()` predicate from
// lib/signal-taxonomy). Click slice -> navigates to /customer?signal=<key> and
// pops a toast confirming the filter.
//
// Only signals with count > 0 are rendered so the slice colors are stable
// across AMs (no flicker when an AM happens to have zero of one signal).
// ---------------------------------------------------------------------------

import { useMemo } from "react";
import { Pie } from "react-chartjs-2";
import {
  Chart as ChartJS,
  ArcElement,
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
  SIGNAL_KEYS,
  SIGNAL_LABELS,
  SignalKey,
  customerHasSignal,
} from "@/lib/customer/signal-taxonomy";
import type { ScoredCustomerV2 } from "@/lib/customer/types";

ChartJS.register(ArcElement, Tooltip, Legend);

type Props = {
  customers: ScoredCustomerV2[];
  amName: string;
};

// Stable signal -> color mapping. Picks a brand-aware palette so multi-AM
// switches keep the same color for the same signal across renders.
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

export function SignalMixPie({ customers, amName }: Props) {
  const router = useRouter();
  const { showToast } = useToast();

  const { labels, counts, keys, colors, total } = useMemo(() => {
    const tally: Record<SignalKey, number> = {
      client_silent: 0,
      we_silent: 0,
      resp_drop: 0,
      vol_collapse: 0,
      usage_low: 0,
      billing: 0,
      perf_flag: 0,
    };
    for (const c of customers) {
      for (const k of SIGNAL_KEYS) {
        if (customerHasSignal(c, k)) tally[k]++;
      }
    }
    const active = SIGNAL_KEYS.filter((k) => tally[k] > 0);
    return {
      labels: active.map((k) => SIGNAL_LABELS[k]),
      counts: active.map((k) => tally[k]),
      keys: active,
      colors: active.map((k) => SIGNAL_COLORS[k]),
      total: active.reduce((acc, k) => acc + tally[k], 0),
    };
  }, [customers]);

  const data = {
    labels,
    datasets: [
      {
        data: counts,
        backgroundColor: colors,
        // Phase 33.brand-watchfire-PR4-deferred — hairline wedge separator per spec §7.
        borderWidth: 1,
        borderColor: CHART_COLORS.bg,
        hoverBorderWidth: 2,
        // Phase 33.brand-watchfire-PR7-34 — hover lift 6→9 per spec §11 row 34.
        hoverOffset: 9,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    // Phase 33.brand-watchfire-PR6-complete — spec §11 row 10: wedges expand from center.
    animation: {
      animateRotate: false,
      animateScale: true,
      duration: 1500,
      easing: CHART_ANIMATION.easing,
    },
    // Phase 33.brand-watchfire-PR8-43 — segment proportion update animation per spec §11 row 43.
    animations: {
      numbers: {
        duration: 1200,
        easing: "easeOutCubic",
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: CHART_TOOLTIP_STYLE,
    },
    onClick: (_e: unknown, els: { index: number }[]) => {
      if (!els[0]) return;
      const idx = els[0].index;
      const key = keys[idx];
      if (!key) return;
      const params = new URLSearchParams();
      params.set("am", amName);
      params.set("signal", key);
      router.push(`/customer?${params.toString()}`);
      showToast(
        `Filtered to ${SIGNAL_LABELS[key]} - ${counts[idx]} customers`,
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
        Signal mix
      </div>
      <div
        style={{
          fontSize: "11px",
          color: CHART_COLORS.muted,
          marginBottom: "10px",
        }}
      >
        <AnimatedNumber value={total} /> signal hits - click to filter
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "6px 12px",
          marginBottom: "8px",
          fontSize: "11px",
          color: CHART_COLORS.muted,
        }}
      >
        {keys.map((k, i) => (
          <span
            key={k}
            style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: colors[i],
              }}
            ></span>
            {SIGNAL_LABELS[k]}{" "}
            <strong style={{ color: CHART_COLORS.midnight, fontWeight: 600 }}>
              <AnimatedNumber value={counts[i]} />
            </strong>
          </span>
        ))}
      </div>
      <div style={{ position: "relative", width: "100%", height: "180px" }}>
        {total === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "11px",
              color: CHART_COLORS.muted,
            }}
          >
            No active signals in scope
          </div>
        ) : (
          <Pie data={data} options={options as any} />
        )}
      </div>
    </div>
  );
}
