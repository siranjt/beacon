"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (3 hex/rgba + 0 tailwind-rose swept)

import { useEffect, useMemo, useState } from "react";
import { POD_MAP } from "@/lib/customer/config";

const POD_COLOR_DOT: Record<string, string> = {
  "Pod 1": "bg-violet-500",
  "Pod 2": "bg-cyan-500",
  "Pod 3": "bg-emerald-500",
  "Pod 4": "bg-amber-500",
  "Pod 5": "bg-pink-500",
  Floating: "bg-slate-500",
};

const POD_OPTIONS = ["All", "Pod 1", "Pod 2", "Pod 3", "Pod 4", "Pod 5", "Floating"];

type Stoplight = "RED" | "YELLOW" | "GREEN";

type MovementRow = {
  entity_id: string;
  bizname: string;
  am_name: string;
  pod?: string;
  from: Stoplight;
  to: Stoplight;
  composite_from: number;
  composite_to: number;
  plan_amount: number;
};

type Movement = {
  days: number;
  comparedAt: string;
  currentAt: string;
  flippedToRed: MovementRow[];
  recoveries: MovementRow[];
  degraded: MovementRow[];
};

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: Movement }
  | { status: "building_history"; days: number };

type Props = {
  days?: number;
  onJumpToAm?: (am: string) => void;
};

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `$${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return n > 0 ? `$${Math.round(n).toLocaleString()}` : "$0";
}

function StoplightChip({ tier }: { tier: Stoplight }) {
  // Phase 17.E — light-theme stoplight chips matching .zoca-chip-* family.
  const styles: Record<Stoplight, React.CSSProperties> = {
    RED: {
      background: "rgba(124, 45, 18, 0.12)",
      color: "var(--zoca-pink-bright)",
      border: "1px solid rgba(200, 67, 29, 0.22)",
    },
    YELLOW: {
      background: "rgba(245,158,11,0.10)",
      color: "#b45309",
      border: "1px solid rgba(245,158,11,0.24)",
    },
    GREEN: {
      background: "rgba(16,185,129,0.08)",
      color: "#047857",
      border: "1px solid rgba(16,185,129,0.22)",
    },
  };
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
      style={styles[tier]}
    >
      {tier === "RED" ? "NEEDS CALL" : tier === "YELLOW" ? "MONITOR" : "HEALTHY"}
    </span>
  );
}

function MovementGroup({
  title,
  hint,
  rows,
  emptyText,
  emptyTone,
  onJumpToAm,
  maxRows = 8,
}: {
  title: string;
  hint: string;
  rows: MovementRow[];
  emptyText: string;
  emptyTone?: "good" | "neutral";
  onJumpToAm?: (am: string) => void;
  maxRows?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rows : rows.slice(0, maxRows);
  const hasMore = rows.length > maxRows;
  return (
    <div className="zoca-card" style={{ padding: "14px 14px 12px" }}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div>
          <h4 className="font-bold text-zoca-text" style={{ fontSize: "14px", letterSpacing: "-0.01em" }}>
            {title}{" "}
            <span className="font-normal text-zoca-text-2">({rows.length})</span>
          </h4>
          <p className="mt-0.5 text-[10px] text-zoca-text-2">{hint}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p
          className="py-2 text-[12px]"
          style={{ color: emptyTone === "good" ? "#047857" : "var(--zoca-text-2)" }}
        >
          {emptyText}
        </p>
      ) : (
        <ul className="divide-y text-[12px]" style={{ borderColor: "var(--zoca-border)" }}>
          {visible.map((r, idx) => {
            const pod = r.pod || POD_MAP[r.am_name] || "Floating";
            const isTop = idx === 0;
            return (
              <li
                key={r.entity_id}
                className={`flex items-center gap-2 py-1.5 ${isTop ? "rounded px-2 -mx-2" : ""}`}
                style={isTop ? { background: "rgba(200, 67, 29, 0.06)" } : undefined}
              >
                {isTop && (
                  <span
                    className="zoca-chip-pink"
                    style={{ padding: "2px 6px", fontSize: "9px", letterSpacing: "0.08em" }}
                    title="Highest-impact row in this bucket"
                  >
                    #1
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <button
                    onClick={() => onJumpToAm && onJumpToAm(r.am_name)}
                    className="block w-full truncate text-left font-medium text-zoca-text underline-offset-2 hover:underline focus:outline-none"
                    style={{ color: "var(--zoca-text)" }}
                    title={`${r.bizname} · click to open ${r.am_name}'s book`}
                    aria-label={`Open ${r.am_name}'s book (customer ${r.bizname})`}
                  >
                    {r.bizname}
                  </button>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-zoca-text-2">
                    <span>{r.am_name}</span>
                    <span className="inline-flex items-center gap-1">
                      <span
                        className={`h-1 w-1 rounded-full ${POD_COLOR_DOT[pod] || "bg-slate-500"}`}
                        aria-hidden
                      />
                      {pod}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <StoplightChip tier={r.from} />
                  <span className="text-zoca-text-3" aria-hidden>
                    →
                  </span>
                  <StoplightChip tier={r.to} />
                </div>
                <div
                  className="hidden w-20 text-right text-[10px] tabular-nums text-zoca-text-2 sm:block"
                  title={`Composite ${r.composite_from} → ${r.composite_to}`}
                >
                  {r.composite_from} → {r.composite_to}
                </div>
                <div
                  className="w-16 text-right text-[10px] tabular-nums text-zoca-text-2"
                  title={`Plan amount: ${formatMoney(r.plan_amount)}`}
                >
                  {formatMoney(r.plan_amount)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-[11px] text-zoca-text-2 underline-offset-2 hover:underline focus:outline-none"
          style={{ color: "var(--zoca-pink)" }}
        >
          {expanded ? "Show less" : `Show ${rows.length - maxRows} more`}
        </button>
      )}
    </div>
  );
}

function exportMovementCsv(data: Movement, filename: string) {
  const headers = [
    "bucket",
    "entity_id",
    "bizname",
    "am_name",
    "pod",
    "from",
    "to",
    "composite_from",
    "composite_to",
    "plan_amount",
  ];
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  const allRows: Array<{ bucket: string; row: MovementRow }> = [
    ...data.flippedToRed.map((row) => ({ bucket: "flippedToRed", row })),
    ...data.degraded.map((row) => ({ bucket: "degraded", row })),
    ...data.recoveries.map((row) => ({ bucket: "recoveries", row })),
  ];
  for (const { bucket, row } of allRows) {
    const pod = row.pod || POD_MAP[row.am_name] || "Floating";
    lines.push(
      [
        bucket,
        escape(row.entity_id),
        escape(row.bizname),
        escape(row.am_name),
        escape(pod),
        row.from,
        row.to,
        String(row.composite_from),
        String(row.composite_to),
        String(Math.round(row.plan_amount)),
      ].join(","),
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function filterRowsByPod(rows: MovementRow[], podFilter: string): MovementRow[] {
  if (podFilter === "All") return rows;
  return rows.filter((r) => (r.pod || POD_MAP[r.am_name] || "Floating") === podFilter);
}

export default function V2StoplightMovement({ days = 7, onJumpToAm }: Props) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [podFilter, setPodFilter] = useState<string>("All");

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/v2/snapshot/movement?days=${days}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => res.statusText);
          if (!cancelled)
            setState({ status: "error", message: `${res.status}: ${txt.slice(0, 200)}` });
          return;
        }
        const data: Movement = await res.json();
        if (!cancelled) {
            // Phase 33.H.6 — API may soft-fail with building_history flag
            if (data && (data as any).building_history) {
              setState({ status: "building_history", days: (data as any).days || days });
            } else {
              setState({ status: "ready", data });
            }
          }
      } catch (e) {
        if (!cancelled) {
          setState({
            status: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  const filtered = useMemo(() => {
    if (state.status !== "ready") return null;
    return {
      flippedToRed: filterRowsByPod(state.data.flippedToRed, podFilter),
      recoveries: filterRowsByPod(state.data.recoveries, podFilter),
      degraded: filterRowsByPod(state.data.degraded, podFilter),
    };
  }, [state, podFilter]);

  const summary = useMemo(() => {
    if (!filtered) return null;
    const flipped = filtered.flippedToRed.length;
    const recovered = filtered.recoveries.length;
    const degraded = filtered.degraded.length;
    return { flipped, recovered, degraded, net: flipped + degraded - recovered };
  }, [filtered]);

  const handleExport = () => {
    if (state.status !== "ready") return;
    // Export filtered set, so what you see is what you get
    const exportData: Movement = {
      ...state.data,
      flippedToRed: filtered?.flippedToRed || state.data.flippedToRed,
      recoveries: filtered?.recoveries || state.data.recoveries,
      degraded: filtered?.degraded || state.data.degraded,
    };
    const podSuffix = podFilter !== "All" ? `_${podFilter.replace(/\s+/g, "-")}` : "";
    exportMovementCsv(
      exportData,
      `zoca_movement_${state.data.currentAt}_vs_${state.data.comparedAt}${podSuffix}.csv`,
    );
  };

  return (
    <section aria-label="Tier movement" className="mb-7">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3
            className="font-extrabold text-zoca-text"
            style={{ fontSize: "17px", letterSpacing: "-0.015em" }}
          >
            Tier movement
          </h3>
          <p className="mt-0.5 text-[11px] text-zoca-text-2">
            {state.status === "ready"
              ? `Customers whose tier changed between ${state.data.comparedAt} and ${state.data.currentAt}.`
              : `Comparing today's snapshot to ${days} days ago.`}
          </p>
          {summary && (
            <p className="mt-1 text-[12px] text-zoca-text-2">
              <span className="font-semibold" style={{ color: "var(--zoca-pink)" }}>{summary.flipped}</span> flipped
              to needs call · <span className="font-semibold" style={{ color: "#b45309" }}>{summary.degraded}</span>{" "}
              degraded ·{" "}
              <span className="font-semibold" style={{ color: "#047857" }}>{summary.recovered}</span>{" "}
              recovered
              {podFilter !== "All" && (
                <span className="ml-1 text-zoca-text-2"> · {podFilter}</span>
              )}
            </p>
          )}
        </div>
        {state.status === "ready" && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Pod filter chips */}
            <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Filter movement by pod">
              {POD_OPTIONS.map((p) => {
                const active = podFilter === p;
                const dot = POD_COLOR_DOT[p];
                return (
                  <button
                    key={p}
                    onClick={() => setPodFilter(p)}
                    aria-pressed={active}
                    aria-label={`Filter movement to ${p}`}
                    className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition focus:outline-none"
                    style={
                      active
                        ? {
                            borderColor: "var(--zoca-text)",
                            background: "var(--zoca-text)",
                            color: "#ffffff",
                          }
                        : {
                            borderColor: "var(--zoca-border)",
                            background: "var(--zoca-bg-soft)",
                            color: "var(--zoca-text-2)",
                          }
                    }
                  >
                    {dot && <span className={`h-1 w-1 rounded-full ${dot}`} aria-hidden />}
                    {p}
                  </button>
                );
              })}
            </div>
            <button
              onClick={handleExport}
              aria-label="Download movement as CSV"
              title="Download movement as CSV"
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition focus:outline-none"
              style={{
                borderColor: "var(--zoca-border)",
                background: "var(--zoca-bg-soft)",
                color: "var(--zoca-text-2)",
              }}
            >
              <span aria-hidden>↓</span> CSV
            </button>
          </div>
        )}
      </header>

      {state.status === "loading" && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="zoca-card animate-pulse"
              style={{ padding: "14px", minHeight: "180px" }}
            >
              <div className="mb-3 h-4 w-32 rounded" style={{ background: "var(--zoca-bg-tint)" }} />
              <div className="mb-2 h-2 w-44 rounded" style={{ background: "var(--zoca-bg-tint)" }} />
              {Array.from({ length: 5 }).map((__, j) => (
                <div
                  key={j}
                  className="my-2 h-6 w-full rounded"
                  style={{ background: "var(--zoca-bg-soft)" }}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {state.status === "error" && (
        <div
          role="alert"
          className="rounded-2xl px-4 py-3 text-[12px]"
          style={{
            border: "1px solid rgba(245,158,11,0.28)",
            background: "rgba(245,158,11,0.08)",
            color: "#b45309",
          }}
        >
          Signal lost — couldn't load movement: {state.message}. (Likely no snapshot exists for {days} days
          ago yet — the dashboard has been live less than {days} days, or that day's pipeline
          didn't run.)
        </div>
      )}

      {state.status === "building_history" && (
        <div
          className="rounded-2xl px-4 py-3 text-[12px]"
          style={{
            border: "1px solid var(--zoca-border)",
            background: "var(--zoca-bg-soft)",
            color: "var(--zoca-text-2)",
          }}
        >
          Building history — comparing today's snapshot to {state.days} days ago needs a snapshot from that date. Once {state.days} days of data have accumulated, this section will populate automatically.
        </div>
      )}

      {state.status === "ready" && filtered && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <MovementGroup
            title="Slipped to Needs call"
            hint="Anything → Needs call. Top priority for outreach."
            rows={filtered.flippedToRed}
            emptyText="No customers slipped to Needs call in this window. 🎉"
            emptyTone="good"
            onJumpToAm={onJumpToAm}
          />
          <MovementGroup
            title="Degraded"
            hint="Healthy → Monitor. Early warning."
            rows={filtered.degraded}
            emptyText="No early-warning degradations in this window."
            emptyTone="good"
            onJumpToAm={onJumpToAm}
          />
          <MovementGroup
            title="Recoveries"
            hint="Anything → Healthy. Wins worth celebrating."
            rows={filtered.recoveries}
            emptyText="No recoveries to Healthy this window — focus on outreach."
            emptyTone="neutral"
            onJumpToAm={onJumpToAm}
          />
        </div>
      )}
    </section>
  );
}
