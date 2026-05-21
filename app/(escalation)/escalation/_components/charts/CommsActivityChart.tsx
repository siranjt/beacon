"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { useMemo } from "react";
import {
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  CHART_TOOLTIP_STYLE,
  SENDER_COLORS,
} from "./colors";

interface Comm {
  channel: string;
  createdAt: string;
  sender: "client" | "team" | "unknown";
  body: string;
}

export default function CommsActivityChart({
  comms,
  sinceDays,
}: {
  comms: Comm[];
  sinceDays: number;
}) {
  const data = useMemo(() => {
    if (!comms.length) return [];
    const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400000 : 0;
    const buckets = new Map<string, { date: string; client: number; team: number }>();

    for (const m of comms) {
      const t = Date.parse(m.createdAt);
      if (Number.isNaN(t) || (cutoff && t < cutoff)) continue;
      const d = new Date(t);
      const key = d.toISOString().slice(0, 10);
      const e = buckets.get(key) || { date: key, client: 0, team: 0 };
      if (m.sender === "client") e.client++;
      else if (m.sender === "team") e.team++;
      buckets.set(key, e);
    }
    // Fill missing days so the area chart doesn't gap-jump.
    const days = sinceDays > 0 ? sinceDays : 90;
    const out: { date: string; client: number; team: number; label: string }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const e = buckets.get(key) || { date: key, client: 0, team: 0 };
      const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      out.push({ ...e, label });
    }
    return out;
  }, [comms, sinceDays]);

  const totalClient = data.reduce((a, b) => a + b.client, 0);
  const totalTeam = data.reduce((a, b) => a + b.team, 0);

  if (!data.length) {
    return (
      <div className="text-xs text-muted text-center py-8">No comms in this window.</div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2 px-1">
        <div>
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted">
            ● Comms activity
          </div>
          <div className="text-2xl font-extrabold tracking-tight">
            {totalClient + totalTeam}{" "}
            <span className="text-muted text-sm font-medium">messages</span>
          </div>
        </div>
        <div className="flex gap-3 text-xs">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: SENDER_COLORS.client }} />
            Client <strong className="text-text2">{totalClient}</strong>
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: SENDER_COLORS.team }} />
            Team <strong className="text-text2">{totalTeam}</strong>
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={170}>
        <AreaChart data={data} margin={{ top: 8, right: 4, left: -28, bottom: 0 }}>
          <defs>
            <linearGradient id="clientFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SENDER_COLORS.client} stopOpacity={0.45} />
              <stop offset="100%" stopColor={SENDER_COLORS.client} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="teamFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SENDER_COLORS.team} stopOpacity={0.4} />
              <stop offset="100%" stopColor={SENDER_COLORS.team} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval={Math.max(1, Math.floor(data.length / 6))}
            tick={{ fontSize: 10 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={24}
            tick={{ fontSize: 10 }}
          />
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
            cursor={{ stroke: "#ffa8cd", strokeWidth: 0.5, strokeDasharray: "2 3" }}
          />
          <Area
            type="monotone"
            dataKey="team"
            stackId="1"
            stroke={SENDER_COLORS.team}
            strokeWidth={1.5}
            fill="url(#teamFill)"
            name="Team"
          />
          <Area
            type="monotone"
            dataKey="client"
            stackId="1"
            stroke={SENDER_COLORS.client}
            strokeWidth={1.5}
            fill="url(#clientFill)"
            name="Client"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
