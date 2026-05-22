"use client";
import { useRouter } from "next/navigation";
import type { CoachingRow, CoachingMetric } from "@/lib/customer/coaching";

type Props = {
  amName: string;
  row: CoachingRow | null;
};

type MetricDef = {
  key: CoachingMetric;
  label: string;
  short: string;
  explainer: string;
  fg: string;
  bg: string;
  border: string;
  /** v2 query-string filter to land on when the manager clicks through. */
  filterParam: string;
};

const METRICS: MetricDef[] = [
  {
    key: "untouched_7d",
    label: "RED untouched >7d",
    short: "Untouched 7d",
    explainer:
      "RED customers in this AM's book where no am_action was logged AND no comms recorded in the last 7 days.",
    fg: "#e11d48",
    bg: "rgba(244,63,94,0.08)",
    border: "rgba(244,63,94,0.22)",
    filterParam: "act",
  },
  {
    key: "stale_14d",
    label: "Stale RED >14d",
    short: "Stale 14d",
    explainer:
      "RED customers whose last_any_iso is null or more than 14 days old.",
    fg: "#b45309",
    bg: "rgba(245,158,11,0.08)",
    border: "rgba(245,158,11,0.22)",
    filterParam: "quiet",
  },
  {
    key: "noreach_streak",
    label: "No-reach streak (3+)",
    short: "No-reach 3+",
    explainer:
      "Customers where the last three am_actions logged by this AM are all 'No reach'.",
    fg: "#7c3aed",
    bg: "rgba(124,58,237,0.08)",
    border: "rgba(124,58,237,0.22)",
    filterParam: "act",
  },
  {
    key: "snooze_ignored",
    label: "Snooze ignored",
    short: "Snooze ignored",
    explainer:
      "Customers this AM snoozed where the snooze has elapsed and no am_action has been logged since.",
    fg: "#0284c7",
    bg: "rgba(2,132,199,0.08)",
    border: "rgba(2,132,199,0.22)",
    filterParam: "snoozed",
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

export default function V2OneOnOneCoaching({ amName, row }: Props) {
  const router = useRouter();

  return (
    <section
      className="mb-4 rounded-zoca-lg bg-zoca-bg-soft p-4 md:p-5"
      style={{ border: "0.5px solid var(--zoca-border)" }}
    >
      <h2
        className="font-extrabold text-zoca-text"
        style={{ fontSize: "15px", letterSpacing: "-0.01em" }}
      >
        Coaching loops
      </h2>
      <p className="mt-0.5 text-[11px] text-zoca-text-2">
        Behavioral signals on what's falling through. Click a non-zero card to
        view the matching cohort in this AM's Beacon.
      </p>

      {!row ? (
        <div className="mt-3 rounded-lg bg-[color:var(--zoca-bg-soft)] px-3 py-3 text-[12px] text-zoca-text-2">
          Coaching signals not available — Postgres may be unreachable.
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {METRICS.map((m) => {
            const c = getCount(row, m.key);
            const active = c > 0;
            return (
              <button
                key={m.key}
                type="button"
                disabled={!active}
                title={m.explainer}
                onClick={() => {
                  if (!active) return;
                  const params = new URLSearchParams();
                  params.set("am", amName);
                  params.set("filter", m.filterParam);
                  router.push(`/customer?${params.toString()}`);
                }}
                className="flex flex-col items-start gap-1 rounded-lg p-3 text-left transition focus:outline-none focus-visible:ring-2"
                style={
                  active
                    ? {
                        background: m.bg,
                        border: `1px solid ${m.border}`,
                        color: m.fg,
                        cursor: "pointer",
                      }
                    : {
                        background: "var(--zoca-bg-soft)",
                        border: "1px solid var(--zoca-border)",
                        color: "var(--zoca-text-soft)",
                        cursor: "default",
                      }
                }
              >
                <span
                  className="tabular-nums font-extrabold"
                  style={{ fontSize: "20px", lineHeight: 1 }}
                >
                  {c}
                </span>
                <span
                  className="text-[11px] font-semibold uppercase tracking-wider"
                  style={{ letterSpacing: "0.04em" }}
                >
                  {m.short}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
