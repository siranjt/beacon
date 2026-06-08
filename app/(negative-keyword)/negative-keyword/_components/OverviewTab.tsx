"use client";

/**
 * Negative Keyword Beacon — Overview tab. Phase NK-4 (polish rev).
 *
 * 6 KPI cards (Total / Cancellation / Billing / Lead quality / Technical /
 * Tickets created) mirror the original standalone dashboard's category
 * breakdown.
 *
 * Charts: risk-category donut, source bar chart, daily-volume line,
 * AM-exposure horizontal bar (top 10 AMs by alert count).
 *
 * All Watchfire palette. Charts derive aggregates from the alerts array
 * client-side — no extra fetches.
 */

import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
  PieChart,
  Pie,
  LineChart,
  Line,
} from "recharts";
import type {
  AlertItem,
  AlertSource,
  RiskCategory,
} from "@/lib/negative-keyword/types";
import {
  ALERT_SOURCES,
  RISK_CATEGORIES,
} from "@/lib/negative-keyword/types";
import type { AlertsFilter } from "./Dashboard";

interface Props {
  alerts: AlertItem[];
  loading: boolean;
  onJumpTo: (seed: Partial<AlertsFilter>) => void;
}

const CATEGORY_COLORS: Record<RiskCategory, string> = {
  Cancellation: "#7C2D12", // Deep Crimson
  Billing: "#D9A441", // Brass
  "Lead quality": "#C8431D", // Ember
  Technical: "#2A4D5C", // Sea Lapis
  Disappointed: "#4A7C59", // Patina
  Flagged: "#8B7A66", // Faded Smoke
};

const SOURCE_COLORS: Record<AlertSource, string> = {
  "App Chat": "#C8431D",
  Email: "#D9A441",
  SMS: "#2A4D5C",
  Phone: "#7C2D12",
  Video: "#4A7C59",
};

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

function KpiCard({
  label,
  value,
  sub,
  accent,
  onClick,
}: {
  label: string;
  value: number;
  sub?: string;
  accent: string;
  onClick?: () => void;
}) {
  const clickable = !!onClick;
  return (
    <div
      className={`surface nk-kpi ${clickable ? "is-clickable" : ""}`}
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={(e) => {
        if (!clickable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      <div className="nk-kpi-rule" style={{ background: accent }} aria-hidden />
      <div className="nk-kpi-label">{label}</div>
      <div className="nk-kpi-value">{value.toLocaleString()}</div>
      {sub && <div className="nk-kpi-sub">{sub}</div>}
    </div>
  );
}

const tickStyle = { fill: "#6E5F50", fontSize: 11 };
const gridStyle = { stroke: "#D4C29B", strokeDasharray: "3 3" };
const tooltipProps = {
  contentStyle: {
    borderRadius: 8,
    background: "#F8EFD7",
    border: "1px solid #D4C29B",
    color: "#2B1F14",
    boxShadow: "0 4px 12px rgba(43,31,20,0.10)",
  },
  cursor: { fill: "rgba(200,67,29,0.08)" },
};

export default function OverviewTab({ alerts, loading, onJumpTo }: Props) {
  /* Counts for the KPI strip. */
  const stats = useMemo(() => {
    const total = alerts.length;
    const businesses = new Set(alerts.map((a) => a.entity_id)).size;
    const byCat: Record<RiskCategory, number> = {
      Cancellation: 0,
      Billing: 0,
      "Lead quality": 0,
      Technical: 0,
      Disappointed: 0,
      Flagged: 0,
    };
    let ticketed = 0;
    for (const a of alerts) {
      byCat[a.risk_category] += 1;
      if (a.ticket_id) ticketed += 1;
    }
    const pct = (n: number) =>
      total === 0 ? "0% of total" : `${((n / total) * 100).toFixed(1)}% of total`;
    return { total, businesses, byCat, ticketed, pct };
  }, [alerts]);

  const categoryData = useMemo(() => {
    return RISK_CATEGORIES.map((name) => ({ name, value: stats.byCat[name] }))
      .filter((d) => d.value > 0);
  }, [stats]);

  const sourceData = useMemo(() => {
    const counts = new Map<AlertSource, number>();
    for (const s of ALERT_SOURCES) counts.set(s, 0);
    for (const a of alerts) counts.set(a.source, (counts.get(a.source) ?? 0) + 1);
    return Array.from(counts.entries()).map(([name, value]) => ({ name, value }));
  }, [alerts]);

  /* Last-14-day daily count. */
  const dailyData = useMemo(() => {
    const buckets: Record<string, number> = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      buckets[d.toISOString().slice(0, 10)] = 0;
    }
    for (const a of alerts) {
      const k = String(a.message_date ?? "").slice(0, 10);
      if (k in buckets) buckets[k] += 1;
    }
    return Object.entries(buckets).map(([date, count]) => ({
      date: fmtTime(date),
      count,
    }));
  }, [alerts]);

  /* Top 10 AMs by alert count — horizontal bar chart. */
  const amData = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of alerts) {
      const name = a.am_name?.trim() || "Unknown";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [alerts]);

  if (loading && alerts.length === 0) {
    return <div className="nk-empty">Loading alerts…</div>;
  }
  if (!loading && alerts.length === 0) {
    return (
      <div className="nk-empty">
        No alerts in the last 14 days. Either the negative-signal lexicon
        hasn&apos;t matched anything (a good sign) or the cron hasn&apos;t
        fired yet — check the dev terminal.
      </div>
    );
  }

  return (
    <div className="nk-overview">
      {/* 6-card KPI strip */}
      <div className="nk-kpi-row nk-kpi-row-6">
        <KpiCard
          label="Total alerts"
          value={stats.total}
          sub={`${stats.businesses} unique businesses`}
          accent="#C8431D"
        />
        <KpiCard
          label="Cancellation"
          value={stats.byCat.Cancellation}
          sub={stats.pct(stats.byCat.Cancellation)}
          accent="#7C2D12"
          onClick={() => onJumpTo({ category: "Cancellation" })}
        />
        <KpiCard
          label="Billing"
          value={stats.byCat.Billing}
          sub="Refund / charge disputes"
          accent="#D9A441"
          onClick={() => onJumpTo({ category: "Billing" })}
        />
        <KpiCard
          label="Lead quality"
          value={stats.byCat["Lead quality"]}
          sub="No bookings / spam leads"
          accent="#C8431D"
          onClick={() => onJumpTo({ category: "Lead quality" })}
        />
        <KpiCard
          label="Technical"
          value={stats.byCat.Technical}
          sub="Platform / service issues"
          accent="#2A4D5C"
          onClick={() => onJumpTo({ category: "Technical" })}
        />
        <KpiCard
          label="Tickets created"
          value={stats.ticketed}
          sub={stats.ticketed === 0 ? "Click Create in table" : "Linear tickets"}
          accent="#4A7C59"
          onClick={() => onJumpTo({ status: "ticketed" })}
        />
      </div>

      {/* Donut + Source bar */}
      <div className="nk-chart-row">
        <div className="surface nk-chart-card">
          <div className="nk-chart-title">Risk category mix</div>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={categoryData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={90}
                  paddingAngle={2}
                  stroke="#F8EFD7"
                  strokeWidth={2}
                  onClick={(slice: { name: string }) => {
                    if (slice && slice.name) {
                      onJumpTo({ category: slice.name as RiskCategory });
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  {categoryData.map((d) => (
                    <Cell
                      key={d.name}
                      fill={CATEGORY_COLORS[d.name as RiskCategory] ?? "#8B7A66"}
                    />
                  ))}
                </Pie>
                <Tooltip {...tooltipProps} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="nk-legend">
            {categoryData.map((d) => (
              <button
                key={d.name}
                type="button"
                className="nk-legend-chip"
                onClick={() => onJumpTo({ category: d.name as RiskCategory })}
              >
                <span
                  className="nk-legend-swatch"
                  style={{ background: CATEGORY_COLORS[d.name as RiskCategory] }}
                  aria-hidden
                />
                {d.name} · {d.value}
              </button>
            ))}
          </div>
        </div>

        <div className="surface nk-chart-card">
          <div className="nk-chart-title">Alerts by source</div>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <BarChart
                data={sourceData}
                layout="vertical"
                margin={{ left: 40, right: 16, top: 8, bottom: 8 }}
              >
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={tickStyle} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={tickStyle} width={70} />
                <Tooltip {...tooltipProps} />
                <Bar
                  dataKey="value"
                  radius={[0, 4, 4, 0]}
                  onClick={(d: { name?: string }) => {
                    if (d?.name) onJumpTo({ source: d.name as AlertSource });
                  }}
                  style={{ cursor: "pointer" }}
                >
                  {sourceData.map((d) => (
                    <Cell key={d.name} fill={SOURCE_COLORS[d.name as AlertSource]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Daily volume + AM exposure */}
      <div className="nk-chart-row">
        <div className="surface nk-chart-card">
          <div className="nk-chart-title">Daily alert volume · 14 days</div>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <LineChart data={dailyData} margin={{ left: 0, right: 12, top: 4, bottom: 4 }}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="date" tick={tickStyle} />
                <YAxis tick={tickStyle} allowDecimals={false} />
                <Tooltip {...tooltipProps} />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="#C8431D"
                  strokeWidth={2}
                  dot={{ fill: "#C8431D", r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="surface nk-chart-card">
          <div className="nk-chart-title">AM exposure · top 10</div>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart
                data={amData}
                layout="vertical"
                margin={{ left: 40, right: 16, top: 4, bottom: 4 }}
              >
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={tickStyle} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={tickStyle}
                  width={100}
                  interval={0}
                />
                <Tooltip {...tooltipProps} />
                <Bar
                  dataKey="value"
                  fill="#C8431D"
                  radius={[0, 4, 4, 0]}
                  onClick={(d: { name?: string }) => {
                    if (d?.name && d.name !== "Unknown") onJumpTo({ am: d.name });
                  }}
                  style={{ cursor: "pointer" }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
