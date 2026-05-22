"use client";

import React from "react";
import { useRouter } from "next/navigation";
import type { CoachingRow, CoachingMetric } from "@/lib/customer/coaching";

import { useActivityLogger } from "@/lib/customer/hooks/use-activity-logger";
type Mode = "manager" | "am";

type Props = {
  mode: Mode;
  rows: CoachingRow[];
  onMetricClick?: (amName: string, metric: CoachingMetric) => void;
};

type MetricDef = {
  key: CoachingMetric;
  label: string;
  short: string;
  explainer: string;
  tone: {
    fg: string;
    bg: string;
    border: string;
  };
};

const METRICS: MetricDef[] = [
  {
    key: "untouched_7d",
    label: "Untouched >7d",
    short: "Untouched 7d",
    explainer:
      "Customers in this AM's book that need a call today (Critical or At-risk) where no am_action was logged AND no comms recorded in the last 7 days. These are the ones falling through.",
    // Phase 33.brand-watchfire-T5 — untouched_7d → Light Ember bg + Deep Ember text.
    tone: {
      fg: "#7C2D12", // Deep Ember
      bg: "rgba(252, 228, 214, 0.80)", // Light Ember
      border: "rgba(200, 67, 29, 0.30)",
    },
  },
  {
    key: "stale_14d",
    label: "Stale >14d",
    short: "Stale 14d",
    explainer:
      "Customers that need a call today whose last_any_iso is null or more than 14 days old — they've been on the needs-call list a long time without a reset. (v1 uses last-comms recency as a proxy for 'stale 14+ days running'.)",
    // Phase 33.brand-watchfire-T5 — stale_14d → Faded Crimson bg + Deep Ember text.
    tone: {
      fg: "#7C2D12", // Deep Ember
      bg: "rgba(245, 201, 182, 0.65)", // Faded Crimson
      border: "rgba(200, 67, 29, 0.32)",
    },
  },
  {
    key: "noreach_streak",
    label: "No-reach streak (3+)",
    short: "No-reach 3+",
    explainer:
      "Customers where the last three am_actions logged by this AM are all 'No reach'. Worth escalating or trying a different channel.",
    // Phase 33.brand-watchfire-T5 — noreach_streak → Buff bg + Smoke text.
    tone: {
      fg: "#6E5F50", // Smoke
      bg: "rgba(235, 224, 194, 0.55)", // Buff
      border: "rgba(217, 164, 65, 0.28)",
    },
  },
  {
    key: "snooze_ignored",
    label: "Snooze ignored",
    short: "Snooze ignored",
    explainer:
      "Customers this AM snoozed where the snooze has elapsed AND no am_action has been logged since. These quietly fell off the radar.",
    // Phase 33.brand-watchfire-T5 — snooze_ignored → Buff bg + Smoke text.
    tone: {
      fg: "#6E5F50", // Smoke
      bg: "rgba(235, 224, 194, 0.55)", // Buff
      border: "rgba(217, 164, 65, 0.28)",
    },
  },
];

function getCount(row: CoachingRow, key: CoachingMetric): number {
  switch (key) {
    case "untouched_7d":
      return row.red_untouched_7d.count;
    case "stale_14d":
      return row.stale_red_14d.count;
    case "noreach_streak":
      return row.noreach_streak_3plus.count;
    case "snooze_ignored":
      return row.snooze_ignored.count;
  }
}

function rowTotal(row: CoachingRow): number {
  return (
    row.red_untouched_7d.count +
    row.stale_red_14d.count +
    row.noreach_streak_3plus.count +
    row.snooze_ignored.count
  );
}

function formatMrr(cents: number): string {
  if (!cents) return "$0/mo";
  const dollars = Math.round(cents / 100);
  return `$${dollars.toLocaleString()}/mo`;
}

export default function V2CoachingLoops({ mode, rows, onMetricClick }: Props) {
  // Phase 33.B.9.1 — log coaching_acted by wrapping the consumer's onMetricClick.
  const logEvent = useActivityLogger();
  const loggedOnMetricClick: ((amName: string, metric: CoachingMetric) => void) | undefined = onMetricClick
    ? (amName: string, metric: CoachingMetric) => {
        logEvent("coaching_acted", {
          surface: mode === "manager" ? "v2_manager_1on1" : "v2_coaching",
          metadata: { am: amName, metric: String(metric) },
        });
        onMetricClick(amName, metric);
      }
    : undefined;
  if (mode === "am") return <CoachingPills row={rows[0]} onMetricClick={loggedOnMetricClick} />;
  return <CoachingTable rows={rows} onMetricClick={loggedOnMetricClick} />;
}

// ---------------------------------------------------------------------------
// Manager mode — full per-AM table
// ---------------------------------------------------------------------------
function CoachingTable({
  rows,
  onMetricClick,
}: {
  rows: CoachingRow[];
  onMetricClick?: (amName: string, metric: CoachingMetric) => void;
}) {
  const router = useRouter();
  const explainerSummary = METRICS.map(
    (m) => `${m.label}: ${m.explainer}`,
  ).join("\n\n");

  return (
    <section className="mb-7">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3
            className="font-extrabold text-zoca-text inline-flex items-center gap-2"
            style={{ fontSize: "17px", letterSpacing: "-0.015em" }}
          >
            Coaching loops
            <span
              role="img"
              aria-label="Coaching loops — what each column means"
              title={explainerSummary}
              tabIndex={0}
              className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full text-[10px] font-semibold"
              style={{
                background: "var(--zoca-bg-soft)",
                color: "var(--zoca-text-2)",
                border: "1px solid var(--zoca-border)",
              }}
            >
              i
            </span>
          </h3>
          <p className="mt-0.5 text-[11px] text-zoca-text-2">
            Per-AM behavioral signals: who has needs-call (Critical + At-risk) customers falling through. Click a non-zero cell to filter the rollup below.
          </p>
        </div>
      </header>

      <div
        // Phase 33.brand-watchfire-T6 — coaching table on Light Parchment.
        className="overflow-hidden rounded-2xl"
        style={{
          background: "var(--zoca-bg-soft)",
          border: "1px solid var(--zoca-border)",
          boxShadow: "0 1px 2px rgba(43,31,20,0.04)",
        }}
      >
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-zoca-text-2">
            No coaching signals across the team this week — keep it up.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead
                className="text-[10.5px] uppercase tracking-wider text-zoca-text-2"
                style={{ background: "var(--zoca-bg-soft)" }}
              >
                <tr>
                  <th className="px-3 py-2 text-left font-medium">AM</th>
                  {METRICS.map((m) => (
                    <th
                      key={m.key}
                      className="px-3 py-2 text-center font-medium"
                      title={m.explainer}
                    >
                      {m.short}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">Needs call</th>
                  <th className="px-3 py-2 text-right font-medium">MRR @ risk</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const sum = rowTotal(row);
                  const muted = sum === 0;
                  return (
                    <tr
                      key={row.am_name}
                      style={{
                        borderTop: "1px solid var(--zoca-border)",
                        opacity: muted ? 0.6 : 1,
                      }}
                    >
                      <td className="px-3 py-2 font-medium text-zoca-text">
                        <span className="inline-flex items-center gap-1.5">
                          <span>{row.am_name}</span>
                          <button
                            type="button"
                            aria-label={`Prep 1:1 for ${row.am_name}`}
                            title={`Prep 1:1 for ${row.am_name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              router.push(
                                `/customer/manager/1on1/${encodeURIComponent(row.am_name)}`,
                              );
                            }}
                            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold transition"
                            style={{
                              background: "transparent",
                              color: "var(--zoca-blue)",
                              border: "1px solid var(--zoca-border)",
                              cursor: "pointer",
                              lineHeight: 1,
                            }}
                            onMouseEnter={(e) => {
                              (e.currentTarget as HTMLElement).style.background =
                                "rgba(200, 67, 29, 0.08)";
                              (e.currentTarget as HTMLElement).style.borderColor =
                                "rgba(200, 67, 29, 0.22)";
                            }}
                            onMouseLeave={(e) => {
                              (e.currentTarget as HTMLElement).style.background =
                                "transparent";
                              (e.currentTarget as HTMLElement).style.borderColor =
                                "var(--zoca-border)";
                            }}
                          >
                            →
                          </button>
                        </span>
                      </td>
                      {METRICS.map((m) => {
                        const c = getCount(row, m.key);
                        const active = c > 0;
                        return (
                          <td
                            key={m.key}
                            className="px-2 py-2 text-center"
                          >
                            <button
                              type="button"
                              disabled={!active}
                              onClick={() =>
                                active && onMetricClick?.(row.am_name, m.key)
                              }
                              title={
                                active
                                  ? `${c} ${m.label} — click to filter`
                                  : `0 ${m.label}`
                              }
                              className="inline-flex flex-col items-center justify-center rounded-lg px-2.5 py-1.5 transition focus:outline-none focus-visible:ring-2"
                              style={
                                active
                                  ? {
                                      background: m.tone.bg,
                                      color: m.tone.fg,
                                      border: `1px solid ${m.tone.border}`,
                                      cursor: "pointer",
                                      minWidth: 56,
                                    }
                                  : {
                                      background: "transparent",
                                      color: "var(--zoca-text-soft)",
                                      border: "1px solid transparent",
                                      cursor: "default",
                                      minWidth: 56,
                                    }
                              }
                              onMouseEnter={(e) => {
                                if (!active) return;
                                (e.currentTarget as HTMLElement).style.boxShadow =
                                  "0 1px 6px rgba(11,5,29,0.08)";
                              }}
                              onMouseLeave={(e) => {
                                (e.currentTarget as HTMLElement).style.boxShadow = "";
                              }}
                            >
                              <span
                                className="font-extrabold tabular-nums"
                                style={{ fontSize: "16px", lineHeight: 1 }}
                              >
                                {c}
                              </span>
                              <span
                                className="mt-0.5"
                                style={{ fontSize: "9.5px", letterSpacing: "0.02em" }}
                              >
                                {m.short.toLowerCase()}
                              </span>
                            </button>
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-zoca-text">
                        {row.total_red}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums font-semibold"
                        style={{ color: "var(--zoca-pink)" }}
                      >
                        {formatMrr(row.total_mrr_at_risk_cents)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AM mode — pill bar (used at top of the AM card list)
// ---------------------------------------------------------------------------
function CoachingPills({
  row,
  onMetricClick,
}: {
  row: CoachingRow | undefined;
  onMetricClick?: (amName: string, metric: CoachingMetric) => void;
}) {
  if (!row) return null;
  const allZero = METRICS.every((m) => getCount(row, m.key) === 0);

  if (allZero) {
    return (
      <div
        role="status"
        className="mb-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-semibold"
        style={{
          background: "rgba(16,185,129,0.08)",
          color: "#047857",
          border: "1px solid rgba(16,185,129,0.22)",
        }}
      >
        <span aria-hidden>✓</span>
        Quiet week — no signals slipping through.
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label="Coaching heads-up"
      className="mb-4 flex flex-wrap items-center gap-2"
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider text-zoca-text-2">
        Heads up
      </span>
      {METRICS.map((m) => {
        const c = getCount(row, m.key);
        const active = c > 0;
        return (
          <button
            key={m.key}
            type="button"
            disabled={!active}
            onClick={() => active && onMetricClick?.(row.am_name, m.key)}
            title={m.explainer}
            className={`beacon-headsup-slide inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-medium transition focus:outline-none focus-visible:ring-2${active ? " beacon-count-breath" : ""}`}
            style={
              active
                ? {
                    background: m.tone.bg,
                    color: m.tone.fg,
                    border: `1px solid ${m.tone.border}`,
                    cursor: "pointer",
                  }
                : {
                    background: "var(--zoca-bg-soft)",
                    color: "var(--zoca-text-soft)",
                    border: "1px solid var(--zoca-border)",
                    cursor: "default",
                  }
            }
          >
            <span className="tabular-nums font-extrabold">{c}</span>
            <span>{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}
