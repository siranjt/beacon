"use client";

/**
 * Negative Keyword Beacon — Overview tab. Phase NK-4.4.
 *
 * Surfaces:
 *   - 4 KPI cards (open / ticketed / dismissed / AI-classified)
 *   - Donut chart: risk_category distribution (clickable → jump to
 *     Alerts tab pre-filtered to that category)
 *   - Bar chart: source distribution (clickable → jump to Alerts pre-filtered)
 *   - Line chart: alerts/day for the last 14 days
 *
 * Charts derive aggregates client-side from the alerts array passed in.
 * No server round-trip per chart — same data as Alerts tab.
 *
 * Recharts (not Chart.js) for consistency with Miss Payment Beacon and
 * the rest of the umbrella's chart palette work.
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

/* Watchfire palette mapping for the categories.
   Distinct, distinguishable at chart-segment size, all from Beacon's
   palette (no rogue Tailwind colors). */
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
}: {
  label: string;
  value: number;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="surface nk-kpi">
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
  /* KPI counts. Open = no ticket + not dismissed. */
  const stats = useMemo(() => {
    let open = 0;
    let ticketed = 0;
    let dismissed = 0;
    let ai = 0;
    for (const a of alerts) {
      if (a.ticket_id) ticketed += 1;
      else if (a.dismissed_at) dismissed += 1;
      else open += 1;
      if (a.classifier === "ai") ai += 1;
    }
    return { open, ticketed, dismissed, ai };
  }, [alerts]);

  /* Category breakdown for the donut. Skip empty categories so the
     chart doesn't render zero-slice ghosts. */
  const categoryData = useMemo(() => {
    const counts = new Map<RiskCategory, number>();
    for (const c of RISK_CATEGORIES) counts.set(c, 0);
    for (const a of alerts) {
      counts.set(a.risk_category, (counts.get(a.risk_category) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .filter(([, v]) => v > 0)
      .map(([name, value]) => ({ name, value }));
  }, [alerts]);

  /* Source breakdown for the bar chart. Keeps zero buckets so the
     viewer sees which channels are quiet vs. loud. */
  const sourceData = useMemo(() => {
    const counts = new Map<AlertSource, number>();
    for (const s of ALERT_SOURCES) counts.set(s, 0);
    for (const a of alerts) {
      counts.set(a.source, (counts.get(a.source) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([name, value]) => ({ name, value }));
  }, [alerts]);

  /* Last-14-day daily count for the line chart. Pre-populates each day
     with zero so quiet stretches show as flat-line, not gaps.
     Postgres DATE → neon driver may return either "YYYY-MM-DD" string
     OR a full ISO timestamp depending on column metadata; normalize
     both to the first 10 chars so the key comparison is robust. */
  const dailyData = useMemo(() => {
    const buckets: Record<string, number> = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      buckets[key] = 0;
    }
    for (const a of alerts) {
      const dateKey = String(a.message_date ?? "").slice(0, 10);
      if (dateKey in buckets) {
        buckets[dateKey] += 1;
      }
    }
    return Object.entries(buckets).map(([date, count]) => ({
      date: fmtTime(date),
      count,
    }));
  }, [alerts]);

  if (loading && alerts.length === 0) {
    return <div className="nk-empty">Loading alerts…</div>;
  }
  if (!loading && alerts.length === 0) {
    return (
      <div className="nk-empty">
        No alerts in the last 14 days. Either nobody&apos;s flagging anything (good)
        or the cron hasn&apos;t fired yet — check the dev terminal.
      </div>
    );
  }

  return (
    <div className="nk-overview">
      {/* KPI strip */}
      <div className="nk-kpi-row">
        <KpiCard label="Open" value={stats.open} sub="not ticketed or dismissed" accent="#C8431D" />
        <KpiCard label="Ticketed" value={stats.ticketed} sub="Linear ticket created" accent="#D9A441" />
        <KpiCard label="Dismissed" value={stats.dismissed} sub="AM marked as noise" accent="#8B7A66" />
        <KpiCard label="AI-classified" value={stats.ai} sub="vs regex fallback" accent="#2A4D5C" />
      </div>

      {/* Charts: donut + bar (side by side) */}
      <div className="nk-chart-row">
        <div className="surface nk-chart-card">
          <div className="nk-chart-title">By risk category</div>
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
          <div className="nk-chart-title">By source</div>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={sourceData} margin={{ left: 0, right: 12, top: 4, bottom: 4 }}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="name" tick={tickStyle} />
                <YAxis tick={tickStyle} allowDecimals={false} />
                <Tooltip {...tooltipProps} />
                <Bar
                  dataKey="value"
                  radius={[4, 4, 0, 0]}
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

      {/* Daily trend */}
      <div className="surface nk-chart-card">
        <div className="nk-chart-title">Alerts per day · last 14 days</div>
        <div style={{ height: 200 }}>
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
    </div>
  );
}
