"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  CLASSIFICATION_COLORS,
  CLASSIFICATION_LABELS,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  CHART_TOOLTIP_STYLE,
} from "./colors";

interface Ticket {
  createdAt: string;
  classification: string;
}

const ORDER = [
  "Churn Ticket",
  "Retention Risk Alert",
  "Subscription Support Ticket",
  "paid_user_offboarding",
  "Subscription_Cancellation",
];

export default function TicketsOverTimeChart({
  tickets,
  weeks = 12,
}: {
  tickets: Ticket[];
  weeks?: number;
}) {
  const data = useMemo(() => {
    if (!tickets.length) return [];

    // Bucket by ISO-week starting Monday.
    const startOfWeek = (d: Date) => {
      const x = new Date(d);
      const day = (x.getDay() + 6) % 7; // Mon=0 ... Sun=6
      x.setDate(x.getDate() - day);
      x.setHours(0, 0, 0, 0);
      return x;
    };

    const today = startOfWeek(new Date());
    const buckets = new Map<number, Record<string, number>>();
    for (let w = weeks - 1; w >= 0; w--) {
      const ts = today.getTime() - w * 7 * 86400000;
      buckets.set(ts, {});
    }

    for (const t of tickets) {
      const tt = Date.parse(t.createdAt);
      if (Number.isNaN(tt)) continue;
      const wkStart = startOfWeek(new Date(tt)).getTime();
      const inRange = wkStart >= today.getTime() - (weeks - 1) * 7 * 86400000;
      if (!inRange) continue;
      const cls = t.classification || "other";
      const e = buckets.get(wkStart) || {};
      e[cls] = (e[cls] || 0) + 1;
      buckets.set(wkStart, e);
    }

    return Array.from(buckets.entries()).map(([ts, counts]) => ({
      label: new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      ...counts,
    }));
  }, [tickets, weeks]);

  if (!data.length) {
    return <div className="text-xs text-muted text-center py-8">No ticket history.</div>;
  }

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted px-1 mb-1">
        ● Tickets over time
      </div>
      <ResponsiveContainer width="100%" height={120}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} interval={Math.max(0, Math.floor(data.length / 6))} tick={{ fontSize: 9 }} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={20} tick={{ fontSize: 9 }} />
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
            cursor={{ fill: "rgba(255,168,205,0.06)" }}
          />
          {ORDER.map((cls) => (
            <Bar
              key={cls}
              dataKey={cls}
              stackId="a"
              fill={CLASSIFICATION_COLORS[cls] || "#7e8794"}
              name={CLASSIFICATION_LABELS[cls] || cls}
              radius={[2, 2, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
