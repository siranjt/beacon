"use client";

import { useMemo } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { CHANNEL_COLORS, CHANNEL_LABELS, CHART_TOOLTIP_ITEM_STYLE, CHART_TOOLTIP_LABEL_STYLE, CHART_TOOLTIP_STYLE } from "./colors";

interface Comm { channel: string; createdAt: string; sender: string; }

export default function ChannelMixDonut({
  comms,
  sinceDays,
  selected,
  onSelect,
}: {
  comms: Comm[];
  sinceDays: number;
  selected: string | null;
  onSelect: (channel: string | null) => void;
}) {
  const data = useMemo(() => {
    const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400000 : 0;
    const counts: Record<string, number> = {};
    for (const m of comms) {
      const t = Date.parse(m.createdAt);
      if (Number.isNaN(t) || (cutoff && t < cutoff)) continue;
      counts[m.channel] = (counts[m.channel] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([k, v]) => ({ name: k, label: CHANNEL_LABELS[k] || k, value: v }))
      .sort((a, b) => b.value - a.value);
  }, [comms, sinceDays]);

  const total = data.reduce((a, b) => a + b.value, 0);

  if (!total) {
    return (
      <div className="text-xs text-muted text-center py-8">No comms in this window.</div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="text-[10px] uppercase tracking-wider font-bold text-muted">
          ● Channel mix
        </div>
        {selected && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-[10px] text-muted hover:text-text"
          >
            clear ✕
          </button>
        )}
      </div>
      <div className="flex items-center gap-3">
        <div className="relative w-[120px] h-[120px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="label"
                innerRadius={36}
                outerRadius={56}
                paddingAngle={2}
                stroke="none"
                onClick={(e: any) => onSelect(e?.payload?.name === selected ? null : e?.payload?.name)}
              >
                {data.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={CHANNEL_COLORS[entry.name] || "#7e8794"}
                    fillOpacity={selected === null || selected === entry.name ? 1 : 0.3}
                    style={{ cursor: "pointer", transition: "fill-opacity 0.15s" }}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                itemStyle={CHART_TOOLTIP_ITEM_STYLE}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <div className="text-xl font-extrabold tracking-tight leading-none">{total}</div>
            <div className="text-[9px] text-muted mt-0.5">total</div>
          </div>
        </div>
        <ul className="flex-1 text-xs space-y-1">
          {data.map((d) => {
            const active = selected === d.name;
            return (
              <li key={d.name}>
                <button
                  type="button"
                  onClick={() => onSelect(active ? null : d.name)}
                  className={`w-full flex items-center justify-between px-2 py-0.5 rounded ${
                    active ? "bg-panel2" : "hover:bg-panel2/60"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ background: CHANNEL_COLORS[d.name] }}
                    />
                    {d.label}
                  </span>
                  <span className="text-muted2">{d.value}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
