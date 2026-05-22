"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (2 hex/rgba + 0 tailwind-rose swept)
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CoachingMetric } from "@/lib/customer/coaching";

type AmOutcomeStats = {
  am_name: string;
  actions_total: number;
  connected: number;
  voicemail: number;
  no_reach: number;
  escalated: number;
  re_engaged: number;
};

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: AmOutcomeStats[] };

const METRIC_LABEL: Record<CoachingMetric, string> = {
  untouched_7d: "RED untouched >7d",
  stale_14d: "Stale RED >14d",
  noreach_streak: "No-reach streak (3+)",
  snooze_ignored: "Snooze ignored",
};

type Props = {
  daysBack?: number;
  /** Phase 27 — when set, filter the rollup to a single AM + show banner. */
  coachingFilter?: { amName: string; metric: CoachingMetric } | null;
  onClearCoachingFilter?: () => void;
};

/**
 * Phase 15.2 — AM activity rollup. Renders a per-AM table of action counts
 * + outcome breakdown over the last N days. Empty state when no actions
 * have been logged yet (Phase 9 wired but unused).
 *
 * Phase 17.D — light-themed to match the Zoca brand palette.
 * Phase 27   — optional coachingFilter prop narrows table to one AM.
 * Phase 29   — adds a small "Prep 1:1 →" affordance per AM row.
 */
export default function V2AmActivityRollup({
  daysBack = 7,
  coachingFilter = null,
  onClearCoachingFilter,
}: Props) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v2/am-activity?days=${daysBack}`, { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (!data.ok) {
          setState({ status: "error", message: data.error || `HTTP ${res.status}` });
          return;
        }
        setState({ status: "ready", rows: (data.rows ?? []) as AmOutcomeStats[] });
      } catch (e) {
        if (!cancelled) {
          setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [daysBack]);

  const displayRows = useMemo(() => {
    if (state.status !== "ready") return [];
    if (!coachingFilter) return state.rows;
    return state.rows.filter((r) => r.am_name === coachingFilter.amName);
  }, [state, coachingFilter]);

  return (
    <section className="mb-7">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3
            className="font-extrabold text-zoca-text"
            style={{ fontSize: "17px", letterSpacing: "-0.015em" }}
          >
            AM activity — last {daysBack} days
          </h3>
          <p className="mt-0.5 text-[11px] text-zoca-text-2">
            Per-AM action counts + outcome breakdown from{" "}
            <code className="font-mono">am_actions</code> +{" "}
            <code className="font-mono">outcome_tracking</code>.
          </p>
        </div>
      </header>

      {coachingFilter && (
        <div
          role="status"
          className="mb-3 zoca-fade-in inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold"
          style={{
            background: "rgba(124, 45, 18, 0.12)",
            border: "1px solid rgba(200, 67, 29, 0.22)",
            color: "var(--zoca-pink-bright)",
          }}
        >
          <span>
            Filtered to {coachingFilter.amName} — {METRIC_LABEL[coachingFilter.metric]}.
          </span>
          <button
            type="button"
            onClick={onClearCoachingFilter}
            aria-label="Clear coaching filter"
            style={{
              background: "transparent",
              border: 0,
              color: "inherit",
              cursor: "pointer",
              fontSize: "14px",
              padding: "0 4px",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      )}

      <div
        className="overflow-hidden rounded-2xl"
        style={{
          // Phase 33.brand-watchfire-T6 — AM activity table on Light Parchment.
          background: "var(--zoca-bg-soft)",
          border: "1px solid var(--zoca-border)",
          boxShadow: "0 1px 2px rgba(11,5,29,0.03)",
        }}
      >
        {state.status === "loading" && (
          <div className="px-4 py-6 text-center text-[12px] text-zoca-text-2">
            Loading AM activity…
          </div>
        )}
        {state.status === "error" && (
          <div
            className="px-4 py-6 text-center text-[12px]"
            style={{ color: "var(--zoca-pink)" }}
          >
            Could not load AM activity: {state.message}
          </div>
        )}
        {state.status === "ready" && displayRows.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-zoca-text-2">
            {coachingFilter
              ? `No actions logged for ${coachingFilter.amName} in the last ${daysBack} days.`
              : "No AM actions recorded yet. Track outcomes via the customer card buttons to populate this view."}
          </div>
        )}
        {state.status === "ready" && displayRows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead
                className="text-[10.5px] uppercase tracking-wider text-zoca-text-2"
                style={{ background: "var(--zoca-bg-soft)" }}
              >
                <tr>
                  <th className="px-3 py-2 text-left font-medium">AM</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                  <th className="px-3 py-2 text-right font-medium">Connected</th>
                  <th className="px-3 py-2 text-right font-medium">VM</th>
                  <th className="px-3 py-2 text-right font-medium">No reach</th>
                  <th className="px-3 py-2 text-right font-medium">Escalated</th>
                  <th className="px-3 py-2 text-right font-medium">Re-engaged</th>
                  <th className="px-3 py-2 text-right font-medium">1:1</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row) => (
                  <tr
                    key={row.am_name}
                    className="transition"
                    style={{ borderTop: "1px solid var(--zoca-border)" }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "rgba(252, 228, 214, 0.55)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "transparent";
                    }}
                  >
                    <td className="px-3 py-2 font-medium text-zoca-text">{row.am_name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zoca-text">
                      {row.actions_total}
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums font-semibold"
                      style={{ color: "#047857" }}
                    >
                      {row.connected}
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums font-semibold"
                      style={{ color: "var(--zoca-blue)" }}
                    >
                      {row.voicemail}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zoca-text-2">
                      {row.no_reach}
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums font-semibold"
                      style={{ color: "#b45309" }}
                    >
                      {row.escalated}
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums font-semibold"
                      style={{ color: "#047857" }}
                    >
                      {row.re_engaged}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(
                            `/customer/manager/1on1/${encodeURIComponent(row.am_name)}`,
                          );
                        }}
                        aria-label={`Prep 1:1 for ${row.am_name}`}
                        title={`Prep 1:1 for ${row.am_name}`}
                        className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
                        style={{
                          background: "transparent",
                          color: "var(--zoca-blue)",
                          border: "1px solid var(--zoca-border)",
                          cursor: "pointer",
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.background =
                            "rgba(200, 67, 29, 0.08)";
                          (e.currentTarget as HTMLElement).style.borderColor =
                            "rgba(200, 67, 29, 0.22)";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.background = "transparent";
                          (e.currentTarget as HTMLElement).style.borderColor =
                            "var(--zoca-border)";
                        }}
                      >
                        <span>Prep 1:1</span>
                        <span style={{ fontSize: "0.85em", opacity: 0.7 }}>→</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
