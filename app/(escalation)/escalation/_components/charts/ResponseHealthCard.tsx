"use client";

import { useMemo } from "react";

interface Comm {
  channel: string;
  createdAt: string;
  sender: string;
}

export default function ResponseHealthCard({
  comms,
  autoResolveConfidence,
}: {
  comms: Comm[];
  autoResolveConfidence: number | null;
}) {
  const stats = useMemo(() => {
    if (!comms.length) return null;
    // sort ascending so adjacency check works
    const sorted = [...comms].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : 1
    );
    let replies = 0;
    let totalGapMs = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev.sender === "client" && cur.sender === "team") {
        const gap = Date.parse(cur.createdAt) - Date.parse(prev.createdAt);
        if (gap > 0 && gap < 14 * 86400000) {
          totalGapMs += gap;
          replies++;
        }
      }
    }
    const avgReplyMs = replies > 0 ? totalGapMs / replies : null;

    const lastTeam = [...sorted].reverse().find((m) => m.sender === "team");
    const lastClient = [...sorted].reverse().find((m) => m.sender === "client");
    const lastTeamAge = lastTeam ? Date.now() - Date.parse(lastTeam.createdAt) : null;
    const lastClientAge = lastClient ? Date.now() - Date.parse(lastClient.createdAt) : null;

    return { avgReplyMs, lastTeamAge, lastClientAge };
  }, [comms]);

  function fmtMs(ms: number | null): string {
    if (ms == null) return "—";
    const min = ms / 60000;
    if (min < 60) return `${Math.round(min)}m`;
    const hr = min / 60;
    if (hr < 24) return `${hr.toFixed(1)}h`;
    const day = hr / 24;
    return `${day.toFixed(1)}d`;
  }

  const conf = autoResolveConfidence ?? 0;
  const confPct = Math.round(conf * 100);
  // Gauge: stroke-dasharray for circle of r=32 → circumference ≈ 201
  const dash = (conf * 201).toFixed(1);
  const dashColor = conf >= 0.85 ? "#3ecf8e" : conf >= 0.5 ? "#ef9f27" : "#ef5b5b";

  return (
    <div className="rounded-xl border border-border bg-panel p-4">
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted px-1 mb-2">
        ● Response health
      </div>
      <div className="flex gap-4 items-center">
        <div className="relative w-20 h-20 shrink-0">
          <svg viewBox="0 0 80 80" className="w-full h-full -rotate-90">
            <circle cx="40" cy="40" r="32" fill="none" stroke="#1f2233" strokeWidth="8" />
            <circle
              cx="40"
              cy="40"
              r="32"
              fill="none"
              stroke={dashColor}
              strokeWidth="8"
              strokeDasharray={`${dash} 201`}
              strokeLinecap="round"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <div className="text-base font-extrabold tracking-tight leading-none">{confPct}%</div>
            <div className="text-[8px] text-muted mt-0.5">auto</div>
          </div>
        </div>
        <div className="flex-1 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <div>
            <div className="text-muted text-[10px]">Avg reply</div>
            <div className="text-text2 text-sm font-medium">{fmtMs(stats?.avgReplyMs ?? null)}</div>
          </div>
          <div>
            <div className="text-muted text-[10px]">Last team msg</div>
            <div className="text-text2 text-sm font-medium">{fmtMs(stats?.lastTeamAge ?? null)} ago</div>
          </div>
          <div>
            <div className="text-muted text-[10px]">Last client msg</div>
            <div className="text-text2 text-sm font-medium">{fmtMs(stats?.lastClientAge ?? null)} ago</div>
          </div>
          <div>
            <div className="text-muted text-[10px]">Auto-resolve</div>
            <div className="text-text2 text-sm font-medium">
              {conf >= 0.85 ? "Eligible" : "Human review"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
