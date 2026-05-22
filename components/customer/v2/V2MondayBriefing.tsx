"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (0 hex/rgba + 4 tailwind-rose swept)

import { useEffect, useMemo, useState } from "react";
import ZocaLogo from "@/components/customer/ZocaLogo";
import { ACTIVE_AMS, INCOMING_AMS, POD_MAP } from "@/lib/customer/config";
import type { ScoredCustomerV2, AmActionRow } from "@/lib/customer/types";

const POD_COLOR_DOT: Record<string, string> = {
  "Pod 1": "bg-violet-400",
  "Pod 2": "bg-cyan-400",
  "Pod 3": "bg-emerald-400",
  "Pod 4": "bg-amber-400",
  "Pod 5": "bg-pink-400",
  Floating: "bg-slate-400",
};

type BriefData = {
  am_name: string;
  snapshot_date: string;
  compared_to: string | null;
  book_size: number;
  totals: {
    RED: number;
    YELLOW: number;
    GREEN: number;
    preLaunch: number;
    mrrAtRisk: number;
  };
  top_red: ScoredCustomerV2[];
  degraded_this_week: ScoredCustomerV2[];
  improved_this_week: ScoredCustomerV2[];
  follow_ups: AmActionRow[];
};

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: BriefData };

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `$${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return n > 0 ? `$${Math.round(n).toLocaleString()}` : "$0";
}

function StoplightChip({ tier }: { tier: "RED" | "YELLOW" | "GREEN" }) {
  const map = {
    RED: "bg-zoca-pink/15 text-rose-300",
    YELLOW: "bg-amber-500/15 text-amber-300",
    GREEN: "bg-emerald-500/15 text-emerald-300",
  };
  return (
    <span className={`rounded-zoca-pill px-1.5 py-0.5 text-[10px] font-semibold ${map[tier]}`}>
      {tier === "RED" ? "NEEDS CALL" : tier === "YELLOW" ? "MONITOR" : "HEALTHY"}
    </span>
  );
}

export default function V2MondayBriefing() {
  const [allAms, setAllAms] = useState<string[]>([]);
  const [selectedAm, setSelectedAm] = useState<string>("");
  const [state, setState] = useState<State>({ status: "loading" });
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const am =
      (typeof window !== "undefined" &&
        (new URL(window.location.href).searchParams.get("am") ||
          window.localStorage.getItem("zoca_v2_selected_am"))) ||
      (ACTIVE_AMS[0] as string);
    setSelectedAm(am);
    const set = new Set<string>([...ACTIVE_AMS, ...INCOMING_AMS]);
    setAllAms(Array.from(set).sort());
  }, []);

  useEffect(() => {
    if (!selectedAm) return;
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(
          `/api/v2/am/${encodeURIComponent(selectedAm)}/monday-brief`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          const txt = await res.text().catch(() => res.statusText);
          if (!cancelled)
            setState({ status: "error", message: `${res.status}: ${txt.slice(0, 200)}` });
          return;
        }
        const data: BriefData = await res.json();
        if (!cancelled) setState({ status: "ready", data });
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
  }, [selectedAm]);

  const pod = useMemo(() => POD_MAP[selectedAm] || "Floating", [selectedAm]);

  return (
    <div className="min-h-screen bg-zoca-body text-zoca-text-primary">
      <nav className="sticky top-0 z-50 border-b border-zoca-border bg-zoca-bg-nav backdrop-blur-xl">
        <div className="mx-auto flex max-w-[920px] flex-wrap items-center gap-3 px-4 py-3 md:gap-4 md:px-6">
          <a href="/customer" className="flex items-center gap-2 text-zoca-light-purple-2" aria-label="Beacon home">
            <ZocaLogo height={20} />
            <span className="hidden text-[11px] font-medium uppercase tracking-wider text-zoca-text-soft sm:inline">
              Beacon · Monday Brief
            </span>
          </a>
          {mounted && (
            <select
              value={selectedAm}
              onChange={(e) => setSelectedAm(e.target.value)}
              className="ml-2 rounded-zoca-pill border border-zoca-border-2 bg-zoca-bg-2/60 px-2.5 py-1 text-[12px] text-zoca-text-primary focus:border-zoca-border-3 focus:outline-none"
              aria-label="Select account manager"
            >
              {allAms.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}
          <div className="ml-auto flex items-center gap-2">
            <a
              href={`/customer?am=${encodeURIComponent(selectedAm)}`}
              className="rounded-zoca-pill border border-zoca-border-2 bg-zoca-bg-2/60 px-3 py-1.5 text-[12px] font-medium text-zoca-text-soft transition hover:border-zoca-border-3 hover:text-zoca-text-primary"
            >
              Full book →
            </a>
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-[920px] px-4 pb-24 pt-6 md:px-6">
        <header className="mb-5">
          <h1 className="font-display text-2xl font-bold text-zoca-text-primary">
            Your Monday brief
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-zoca-text-muted">
            <span>{selectedAm}</span>
            <span className="inline-flex items-center gap-1 text-[11px] text-zoca-text-soft">
              <span className={`h-1.5 w-1.5 rounded-full ${POD_COLOR_DOT[pod] || "bg-slate-400"}`} aria-hidden />
              {pod}
            </span>
            {state.status === "ready" && (
              <span className="text-[11px] text-zoca-text-soft">
                · {state.data.book_size} customers · snapshot {state.data.snapshot_date}
              </span>
            )}
          </p>
        </header>

        {state.status === "loading" && (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-zoca border border-zoca-border-2 bg-zoca-bg-2/30" />
            ))}
          </div>
        )}

        {state.status === "error" && (
          <div role="alert" className="rounded-zoca border border-zoca-pink/30 bg-zoca-pink/10 px-5 py-4 text-sm text-zoca-pink-bright">
            Signal lost — couldn't load brief: {state.message}
          </div>
        )}

        {state.status === "ready" && (
          <>
            {/* KPI strip */}
            <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiBox label="Needs call" value={String(state.data.totals.RED)} tone="rose" />
              <KpiBox label="Monitor" value={String(state.data.totals.YELLOW)} tone="amber" />
              <KpiBox label="Healthy" value={String(state.data.totals.GREEN)} tone="emerald" />
              <KpiBox label="MRR @ risk" value={formatMoney(state.data.totals.mrrAtRisk)} tone="rose" />
            </section>

            {/* Top RED */}
            <Panel
              title="🔥 Call these first"
              hint={`Top ${state.data.top_red.length} needs-call customer${state.data.top_red.length === 1 ? "" : "s"} by composite. Click to open the card.`}
              emptyText="Quiet week. No signals to follow."
              empty={state.data.top_red.length === 0}
            >
              <ul className="divide-y divide-zoca-border">
                {state.data.top_red.map((c, i) => (
                  <li key={c.entity_id} className="flex items-center gap-3 py-2 text-[13px]">
                    <span className="w-5 text-center text-[11px] font-bold text-zoca-text-soft tabular-nums">
                      #{i + 1}
                    </span>
                    <a
                      href={`/customer?am=${encodeURIComponent(selectedAm)}#${c.entity_id}`}
                      className="flex-1 truncate font-medium text-zoca-text-primary underline-offset-4 hover:text-zoca-pink-cta hover:underline"
                      title={c.signals_v2.reason_one_line}
                    >
                      {c.company || c.entity_id.slice(0, 8)}
                    </a>
                    <StoplightChip tier={c.signals_v2.stoplight} />
                    <span className="hidden w-20 text-right text-[11px] tabular-nums text-zoca-text-muted sm:inline" title={`Composite ${c.signals_v2.composite}`}>
                      score {c.signals_v2.composite}
                    </span>
                    <span className="w-16 text-right text-[11px] tabular-nums text-rose-300" title="Plan amount">
                      {formatMoney(c.plan_amount || 0)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>

            {/* Degraded since last week */}
            <Panel
              title="⬇ Degraded since last week"
              hint={state.data.compared_to ? `Customers whose stoplight worsened between ${state.data.compared_to} and today.` : "No 7d-ago snapshot yet — comparison disabled."}
              emptyText="No one slipped this week. 🎉"
              empty={state.data.degraded_this_week.length === 0}
            >
              <ul className="divide-y divide-zoca-border">
                {state.data.degraded_this_week.map((c) => (
                  <li key={c.entity_id} className="flex items-center gap-3 py-2 text-[13px]">
                    <a
                      href={`/customer?am=${encodeURIComponent(selectedAm)}#${c.entity_id}`}
                      className="flex-1 truncate font-medium text-zoca-text-primary underline-offset-4 hover:text-zoca-pink-cta hover:underline"
                    >
                      {c.company || c.entity_id.slice(0, 8)}
                    </a>
                    <StoplightChip tier={c.signals_v2.stoplight} />
                  </li>
                ))}
              </ul>
            </Panel>

            {/* Improved since last week */}
            <Panel
              title="⬆ Recoveries this week"
              hint="Customers whose stoplight improved. Celebrate or call to lock the gain."
              emptyText="No recoveries this week — focus on the top signals."
              empty={state.data.improved_this_week.length === 0}
              tone="emerald"
            >
              <ul className="divide-y divide-zoca-border">
                {state.data.improved_this_week.map((c) => (
                  <li key={c.entity_id} className="flex items-center gap-3 py-2 text-[13px]">
                    <a
                      href={`/customer?am=${encodeURIComponent(selectedAm)}#${c.entity_id}`}
                      className="flex-1 truncate font-medium text-zoca-text-primary underline-offset-4 hover:text-zoca-pink-cta hover:underline"
                    >
                      {c.company || c.entity_id.slice(0, 8)}
                    </a>
                    <StoplightChip tier={c.signals_v2.stoplight} />
                  </li>
                ))}
              </ul>
            </Panel>

            {/* Follow-ups */}
            <Panel
              title="📅 Follow-ups this week"
              hint="Customers you tagged with a 7-day reminder."
              emptyText="Nothing scheduled to follow up on."
              empty={state.data.follow_ups.length === 0}
            >
              <ul className="divide-y divide-zoca-border">
                {state.data.follow_ups.map((f) => (
                  <li key={`${f.id}-${f.entity_id}`} className="flex items-center gap-3 py-2 text-[13px]">
                    <span className="w-20 text-[11px] tabular-nums text-zoca-text-soft" title={`Scheduled ${f.follow_up_date}`}>
                      {f.follow_up_date}
                    </span>
                    <a
                      href={`/customer?am=${encodeURIComponent(selectedAm)}#${f.entity_id}`}
                      className="flex-1 truncate font-medium text-zoca-text-primary underline-offset-4 hover:text-zoca-pink-cta hover:underline"
                    >
                      {f.entity_id.slice(0, 8)}
                    </a>
                    {f.reason_code && (
                      <span className="rounded-zoca-pill bg-zoca-bg-3/40 px-1.5 py-0.5 text-[10px] text-zoca-text-soft">
                        {f.reason_code}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          </>
        )}
      </main>

      <footer className="border-t border-zoca-border py-8 text-center">
        <div className="flex flex-col items-center gap-2 opacity-70">
          <ZocaLogo height={18} />
          <p className="text-xs text-zoca-text-soft">
            Beacon · Monday brief · refreshed daily at 22:00 UTC
          </p>
        </div>
      </footer>
    </div>
  );
}

function KpiBox({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "rose" | "amber" | "emerald";
}) {
  const cls =
    tone === "rose"
      ? "text-rose-400"
      : tone === "amber"
        ? "text-amber-400"
        : tone === "emerald"
          ? "text-emerald-400"
          : "text-zoca-text-primary";
  return (
    <div className="rounded-zoca border border-zoca-border-2 bg-zoca-bg-2/40 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-zoca-text-soft">{label}</div>
      <div className={`mt-0.5 font-display text-2xl font-bold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

function Panel({
  title,
  hint,
  emptyText,
  empty,
  tone,
  children,
}: {
  title: string;
  hint: string;
  emptyText: string;
  empty: boolean;
  tone?: "emerald";
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 rounded-zoca border border-zoca-border-2 bg-zoca-bg-2/30 p-4">
      <header className="mb-2">
        <h3 className="font-display text-base font-bold text-zoca-text-primary">{title}</h3>
        <p className="mt-0.5 text-[11px] text-zoca-text-soft">{hint}</p>
      </header>
      {empty ? (
        <p className={`py-2 text-[12px] ${tone === "emerald" ? "text-emerald-300/80" : "text-zoca-text-soft"}`}>
          {emptyText}
        </p>
      ) : (
        children
      )}
    </section>
  );
}
