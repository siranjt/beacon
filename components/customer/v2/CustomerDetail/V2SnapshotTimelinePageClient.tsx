"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (0 hex/rgba + 6 tailwind-rose swept)

// ---------------------------------------------------------------------------
// Phase 30 — Standalone full-page snapshot timeline.
//
// Reached via the "Expand ↗" link from V2DetailHeader. Renders the
// full-variant V2SnapshotTimeline plus an Events log (actions + snoozes)
// for the selected time range. Time-range pill (7/30/90) is fully
// interactive — refetches both the chart payload and the events log.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import type { Stoplight } from "@/lib/customer/config";
import V2SnapshotTimeline from "./V2SnapshotTimeline";

type DaysOpt = 7 | 30 | 90;

type TimelineAction = {
  id: number;
  date: string;
  iso: string;
  am_name: string;
  action_type: string;
  reason_code: string | null;
  note: string | null;
  composite_at_action: number | null;
};

type TimelineSnooze = {
  snoozed_at: string;
  snoozed_until: string;
  am_name: string;
  reason: string | null;
};

type TimelineResponse = {
  ok: boolean;
  entity_id: string;
  days: number;
  generated_at: string;
  composite_series: Array<{ date: string; composite: number; stoplight: "RED" | "YELLOW" | "GREEN" }>;
  actions: TimelineAction[];
  snooze_ranges: TimelineSnooze[];
  stoplight_transitions: Array<{ date: string; from: "RED" | "YELLOW" | "GREEN"; to: "RED" | "YELLOW" | "GREEN" }>;
  error?: string;
};

type Props = {
  entityId: string;
};

const STOPLIGHT_TONE: Record<Stoplight, string> = {
  RED: "bg-zoca-pink/18 text-zoca-pink-bright border-zoca-pink/60",
  YELLOW: "bg-amber-500/18 text-amber-700 border-amber-300/60",
  GREEN: "bg-emerald-500/18 text-emerald-700 border-emerald-300/60",
};

const ACTION_LABEL: Record<string, string> = {
  contacted_connected: "Connected",
  contacted_vm:        "Voicemail",
  contacted_noreach:   "No reach",
  escalated:           "Escalated",
};

function actionPretty(t: string): string {
  return ACTION_LABEL[t] || t;
}

function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400_000));
}

function formatIso(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateOnly(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function V2SnapshotTimelinePageClient({ entityId }: Props) {
  const [days, setDays] = useState<DaysOpt>(90);
  const [customer, setCustomer] = useState<ScoredCustomerV2 | null>(null);
  const [custLoading, setCustLoading] = useState<boolean>(true);
  const [custError, setCustError] = useState<string | null>(null);

  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [eventsOpen, setEventsOpen] = useState<boolean>(true);

  // Fetch customer record once on mount.
  useEffect(() => {
    let cancelled = false;
    setCustLoading(true);
    setCustError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/v2/customer/${encodeURIComponent(entityId)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as {
          ok?: boolean;
          customer?: ScoredCustomerV2;
          error?: string;
        };
        if (cancelled) return;
        if (!json.ok || !json.customer) {
          setCustError(json.error || "Customer not found");
          setCustomer(null);
        } else {
          setCustomer(json.customer);
        }
      } catch (e) {
        if (cancelled) return;
        setCustError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setCustLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityId]);

  // Fetch timeline payload for the events log (the chart fetches its own copy,
  // but we want the same data here so we don't hit the endpoint twice from
  // different mounts of the chart on toggle).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/v2/customer/${encodeURIComponent(entityId)}/timeline?days=${days}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as TimelineResponse;
        if (cancelled) return;
        setTimeline(json);
      } catch {
        if (cancelled) return;
        setTimeline(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityId, days]);

  const sortedActions = useMemo(() => {
    if (!timeline?.actions) return [];
    return [...timeline.actions].sort((a, b) => (a.iso < b.iso ? 1 : -1));
  }, [timeline]);

  const sortedSnoozes = useMemo(() => {
    if (!timeline?.snooze_ranges) return [];
    return [...timeline.snooze_ranges].sort((a, b) =>
      a.snoozed_at < b.snoozed_at ? 1 : -1,
    );
  }, [timeline]);

  const bizname =
    customer?.company || (entityId ? entityId.slice(0, 8) : "Customer");
  const stoplight = customer?.signals_v2?.stoplight;
  const composite = customer?.signals_v2?.composite;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        className="flex flex-wrap items-baseline gap-1 text-[12px] text-zoca-text-2"
      >
        <a
          href={`/customer/${encodeURIComponent(entityId)}`}
          className="inline-flex items-center gap-1 rounded-zoca-pill px-2 py-0.5 hover:bg-zoca-bg-tint hover:text-zoca-text"
        >
          ← Back to detail
        </a>
        <span aria-hidden>/</span>
        <span className="rounded-zoca-pill px-2 py-0.5">Timeline</span>
        <span aria-hidden>/</span>
        <span className="px-2 py-0.5 font-medium text-zoca-text">{bizname}</span>
      </nav>

      {/* Title block */}
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-zoca-text">{bizname}</h1>
          <p className="mt-1 text-[13px] text-zoca-text-2">
            Composite score timeline
          </p>
        </div>
      </div>

      {/* Customer info strip */}
      {custLoading && (
        <div
          className="mt-4 h-10 animate-pulse rounded-zoca bg-zoca-bg-tint"
          aria-busy="true"
        />
      )}
      {custError && (
        <div className="mt-4 rounded-zoca border border-zoca-pink/60 bg-zoca-pink-soft px-3 py-2 text-[12px] text-zoca-pink-bright">
          Customer details unavailable · {custError}
        </div>
      )}
      {!custLoading && !custError && customer && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-zoca border border-zoca-border bg-zoca-bg-soft px-3 py-2 text-[12px] text-zoca-text-2">
          {customer.am_name && (
            <span>
              <span className="text-zoca-text-2">AM</span>{" "}
              <a
                href={`/customer?am=${encodeURIComponent(customer.am_name)}`}
                className="font-medium text-zoca-text hover:text-zoca-pink-cta"
              >
                {customer.am_name}
              </a>
            </span>
          )}
          {customer.plan_amount > 0 && (
            <span className="tabular-nums">
              <span className="text-zoca-text-2">Plan</span>{" "}
              <span className="font-medium text-zoca-text">
                ${customer.plan_amount.toFixed(0)}/mo
              </span>
            </span>
          )}
          {stoplight && (
            <span
              className={`rounded-zoca-pill border px-2 py-0.5 text-[11px] font-semibold ${STOPLIGHT_TONE[stoplight]}`}
            >
              {stoplight}
            </span>
          )}
          {composite !== undefined && composite !== null && (
            <span className="tabular-nums">
              <span className="text-zoca-text-2">Composite</span>{" "}
              <span className="font-semibold text-zoca-text">{composite}</span>
            </span>
          )}
          <span className="font-mono text-[10px] text-zoca-text-2">
            · {entityId.slice(0, 8)}
          </span>
        </div>
      )}

      {/* The full-variant chart */}
      <section
        className="mt-5 rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5"
        aria-label="Composite score timeline"
      >
        <V2SnapshotTimeline
          entityId={entityId}
          variant="full"
          days={days}
          onDaysChange={setDays}
          bizname={customer?.company ?? undefined}
        />
      </section>

      {/* Events log */}
      <section
        className="mt-6 rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5"
        aria-label="Events log"
      >
        <button
          type="button"
          onClick={() => setEventsOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2"
          aria-expanded={eventsOpen}
        >
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zoca-text-2">
            Events log · last {days}d
          </h2>
          <span className="text-[12px] text-zoca-text-2">
            {eventsOpen ? "Hide" : "Show"}
          </span>
        </button>

        {eventsOpen && (
          <div className="mt-3 grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* Actions */}
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-wider text-zoca-text-2">
                Actions ({sortedActions.length})
              </div>
              {sortedActions.length === 0 ? (
                <div className="rounded-zoca border border-zoca-border bg-zoca-bg-tint px-3 py-2 text-[12px] text-zoca-text-2">
                  No actions logged in this window.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-zoca border border-zoca-border">
                  <table className="min-w-full text-[12px]">
                    <thead className="bg-zoca-bg-tint text-left text-[10px] uppercase tracking-wider text-zoca-text-2">
                      <tr>
                        <th className="px-2 py-1.5">When</th>
                        <th className="px-2 py-1.5">AM</th>
                        <th className="px-2 py-1.5">Action</th>
                        <th className="px-2 py-1.5">Reason</th>
                        <th className="px-2 py-1.5 text-right">Comp.</th>
                        <th className="px-2 py-1.5">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedActions.map((a) => (
                        <tr
                          key={a.id || `${a.iso}-${a.action_type}`}
                          className="border-t border-zoca-border align-top"
                        >
                          <td className="px-2 py-1.5 text-zoca-text-2 tabular-nums">
                            {formatIso(a.iso)}
                          </td>
                          <td className="px-2 py-1.5 text-zoca-text">
                            {a.am_name || "—"}
                          </td>
                          <td className="px-2 py-1.5 font-medium text-zoca-text">
                            {actionPretty(a.action_type)}
                          </td>
                          <td className="px-2 py-1.5 text-zoca-text-2">
                            {a.reason_code || "—"}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-zoca-text">
                            {a.composite_at_action !== null
                              ? a.composite_at_action
                              : "—"}
                          </td>
                          <td className="px-2 py-1.5 text-zoca-text-2">
                            {a.note
                              ? a.note.length > 80
                                ? `${a.note.slice(0, 77)}…`
                                : a.note
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Snoozes */}
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-wider text-zoca-text-2">
                Snoozes ({sortedSnoozes.length})
              </div>
              {sortedSnoozes.length === 0 ? (
                <div className="rounded-zoca border border-zoca-border bg-zoca-bg-tint px-3 py-2 text-[12px] text-zoca-text-2">
                  No snoozes in this window.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-zoca border border-zoca-border">
                  <table className="min-w-full text-[12px]">
                    <thead className="bg-zoca-bg-tint text-left text-[10px] uppercase tracking-wider text-zoca-text-2">
                      <tr>
                        <th className="px-2 py-1.5">Snoozed</th>
                        <th className="px-2 py-1.5">Until</th>
                        <th className="px-2 py-1.5 text-right">Days</th>
                        <th className="px-2 py-1.5">AM</th>
                        <th className="px-2 py-1.5">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSnoozes.map((s, idx) => (
                        <tr
                          key={`${s.snoozed_at}-${idx}`}
                          className="border-t border-zoca-border align-top"
                        >
                          <td className="px-2 py-1.5 text-zoca-text-2 tabular-nums">
                            {formatDateOnly(s.snoozed_at)}
                          </td>
                          <td className="px-2 py-1.5 text-zoca-text-2 tabular-nums">
                            {formatDateOnly(s.snoozed_until)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-zoca-text">
                            {daysBetween(s.snoozed_at, s.snoozed_until)}
                          </td>
                          <td className="px-2 py-1.5 text-zoca-text">
                            {s.am_name || "—"}
                          </td>
                          <td className="px-2 py-1.5 text-zoca-text-2">
                            {s.reason || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default V2SnapshotTimelinePageClient;
