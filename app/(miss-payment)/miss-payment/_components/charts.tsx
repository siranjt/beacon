"use client";

/**
 * Miss Payment Beacon — 4-chart grid.
 * Outstanding by AM (horizontal bars, top 10)
 * Outstanding by month (vertical bars, all months)
 * Aging buckets (vertical bars, 0-30 / 31-60 / 61-90 / 90d+)
 * Subscription status (horizontal bars, all distinct statuses)
 *
 * Colors map to Watchfire palette — ember/brass/lapis ramp.
 */

import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from "recharts";
import type { InvoiceRow } from "@/lib/miss-payment/types";

function fmtUsd(v: number | string) {
  const n = typeof v === "string" ? Number(v) : v;
  return "$" + Math.round(n).toLocaleString();
}
function fmtUsdShort(v: number) {
  return "$" + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k";
}

function ChartCard({ title, pillClass, pillText, height = 220, children }: any) {
  return (
    <div className="surface" style={{ padding: 18 }}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-zoca-text">{title}</div>
        {pillText && <span className={pillClass} style={{ fontSize: 10 }}>{pillText}</span>}
      </div>
      <div style={{ height }}>{children}</div>
    </div>
  );
}

// Watchfire-tuned chart tokens
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

function ageBucket(invoiceDate: string): "0-30d" | "31-60d" | "61-90d" | "90d+" | null {
  if (!invoiceDate) return null;
  const t = new Date(invoiceDate).getTime();
  if (isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
  if (days < 0) return null;
  if (days <= 30) return "0-30d";
  if (days <= 60) return "31-60d";
  if (days <= 90) return "61-90d";
  return "90d+";
}

export default function Charts({ rows }: { rows: InvoiceRow[] }) {
  // Outstanding by AM
  const byAmMap = new Map<string, number>();
  rows.forEach((r) => {
    const k = r.amName || "(unassigned)";
    byAmMap.set(k, (byAmMap.get(k) || 0) + r.amountDue);
  });
  const byAm = Array.from(byAmMap.entries())
    .map(([name, value]) => ({ name, value: Math.round(value) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  // Outstanding by month
  const monthOrder = ["March", "April", "May", "June"];
  const byMonthMap = new Map<string, number>();
  rows.forEach((r) => {
    const k = r.invoiceMonth || "(unknown)";
    byMonthMap.set(k, (byMonthMap.get(k) || 0) + r.amountDue);
  });
  const byMonth = monthOrder
    .filter((m) => byMonthMap.has(m))
    .map((name) => ({ name, value: Math.round(byMonthMap.get(name) || 0) }));
  byMonthMap.forEach((value, name) => {
    if (!monthOrder.includes(name)) byMonth.push({ name, value: Math.round(value) });
  });

  // Aging buckets
  const buckets: Record<string, number> = { "0-30d": 0, "31-60d": 0, "61-90d": 0, "90d+": 0 };
  rows.forEach((r) => {
    const b = ageBucket(r.invoiceDate);
    if (b) buckets[b]++;
  });
  const aging = Object.entries(buckets).map(([name, value]) => ({ name, value }));
  // Watchfire ramp: Patina → Brass → Ember → Crimson
  const agingColors = ["#4A7C59", "#D9A441", "#C8431D", "#7C2D12"];

  // Subscription status
  const subMap = new Map<string, number>();
  rows.forEach((r) => {
    const k = r.subscriptionStatus || "(unknown)";
    subMap.set(k, (subMap.get(k) || 0) + 1);
  });
  const subStatus = Array.from(subMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  const subColorByName: Record<string, string> = {
    active: "#4A7C59",        // Patina
    in_trial: "#D9A441",      // Brass
    non_renewing: "#C8431D",  // Ember
    cancelled: "#7C2D12",     // Deep Crimson
    paused: "#2A4D5C",        // Sea Lapis
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <ChartCard title="Outstanding by AM" pillClass="pill-blue" pillText="TOP 10">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={byAm} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid {...gridStyle} horizontal={false} />
            <XAxis type="number" tickFormatter={(v) => fmtUsdShort(v)} tick={tickStyle} stroke="#D4C29B" />
            <YAxis type="category" dataKey="name" width={110} tick={tickStyle} stroke="#D4C29B" />
            <Tooltip formatter={(v: any) => fmtUsd(v)} {...tooltipProps} />
            <defs>
              <linearGradient id="grad-am" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#C8431D" />
                <stop offset="100%" stopColor="#D9A441" />
              </linearGradient>
            </defs>
            <Bar dataKey="value" fill="url(#grad-am)" radius={[0, 6, 6, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Outstanding by month" pillClass="pill-pink" pillText="VISIBLE">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={byMonth}>
            <CartesianGrid {...gridStyle} vertical={false} />
            <XAxis dataKey="name" tick={tickStyle} stroke="#D4C29B" />
            <YAxis tickFormatter={(v) => fmtUsdShort(v)} tick={tickStyle} stroke="#D4C29B" />
            <Tooltip formatter={(v: any) => fmtUsd(v)} {...tooltipProps} />
            <defs>
              <linearGradient id="grad-month" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#C8431D" />
                <stop offset="100%" stopColor="#7C2D12" />
              </linearGradient>
            </defs>
            <Bar dataKey="value" fill="url(#grad-month)" radius={[8, 8, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Aging buckets" pillClass="pill-amber" pillText="DAYS OVERDUE">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={aging}>
            <CartesianGrid {...gridStyle} vertical={false} />
            <XAxis dataKey="name" tick={tickStyle} stroke="#D4C29B" />
            <YAxis tick={tickStyle} stroke="#D4C29B" allowDecimals={false} />
            <Tooltip {...tooltipProps} />
            <Bar dataKey="value" radius={[8, 8, 0, 0]}>
              {aging.map((_, i) => <Cell key={i} fill={agingColors[i]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Subscription status" pillClass="pill-green" pillText="VISIBLE">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={subStatus} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid {...gridStyle} horizontal={false} />
            <XAxis type="number" tick={tickStyle} stroke="#D4C29B" allowDecimals={false} />
            <YAxis type="category" dataKey="name" width={110} tick={tickStyle} stroke="#D4C29B" />
            <Tooltip {...tooltipProps} />
            <Bar dataKey="value" radius={[0, 6, 6, 0]}>
              {subStatus.map((d, i) => (
                <Cell key={i} fill={subColorByName[d.name] || "#8B7A66"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
