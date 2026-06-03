"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (7 hex/rgba + 0 tailwind-rose swept)

import { useEffect, useMemo, useState } from "react";
import type { SnapshotV2, ScoredCustomerV2 } from "@/lib/customer/types";
import type { Stoplight } from "@/lib/customer/config";
import { ACTIVE_AMS, INCOMING_AMS, POD_MAP } from "@/lib/customer/config";
import { AmLink } from "./AmLink";

type Props = {
  snapshot: SnapshotV2;
  initialPod?: string;
  onJumpToAm: (am: string) => void;
};

type SortKey =
  | "am"
  | "pod"
  | "total"
  | "red"
  | "yellow"
  | "green"
  | "action"
  | "pctRed"
  | "mrr"
  | "mrrAtRisk"
  | "flagged"
  | "avg";
type SortDir = "asc" | "desc";

type AmRow = {
  am: string;
  pod: string;
  total: number;
  RED: number;
  YELLOW: number;
  GREEN: number;
  action: number;
  pctRed: number; // 0..100
  mrr: number;
  mrrAtRisk: number; // sum of plan_amount for RED customers
  avgComposite: number;
  topSignal: string;
  flagged: number;          // performance.flag === true count
  // F-purge-churned — `churned30d` column removed; recently-churned customers
  // are dropped from the snapshot entirely on the day they cancel.
  // Phase 33.H.3b — 4-tier health_tier counts (MONITOR fallback)
  critical: number;
  atRisk: number;
  monitor: number;
  healthy: number;
  needsCall: number;
  pctNeedsCall: number;
};

const POD_OPTIONS = ["All", "Pod 1", "Pod 2", "Pod 3", "Pod 4", "Pod 5", "Floating"];

// Phase 33.brand-watchfire-T5 — pod indicator dots → Watchfire palette.
const POD_COLOR_DOT: Record<string, string> = {
  "Pod 1": "bg-[#2A4D5C]", // Sea Lapis
  "Pod 2": "bg-[#4A7C59]", // Patina
  "Pod 3": "bg-[#D9A441]", // Brass
  "Pod 4": "bg-[#C8431D]", // Ember
  "Pod 5": "bg-[#7C2D12]", // Deep Crimson
  Floating: "bg-[#6E5F50]", // Smoke
};

const SIGNAL_HELP =
  "Most common strong signal (≥70) across this AM's book. Numbers: how many customers carry that signal. Signals: We silent (we haven't reached out), Client silent (they've gone dark), Resp drop (their reply rate fell), Vol collapse (conversation volume dropped), Usage low (app activity tanked), Billing (unpaid invoices).";

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `$${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return n > 0 ? `$${Math.round(n).toLocaleString()}` : "$0";
}

function classifyTopSignal(customers: ScoredCustomerV2[]): string {
  const tally = { we: 0, client: 0, drop: 0, vol: 0, usage: 0, billing: 0 };
  for (const c of customers) {
    const s = c.signals_v2;
    if (s.sig_we_silent >= 70) tally.we += 1;
    if (s.sig_client_silent >= 70) tally.client += 1;
    if (s.sig_response_drop >= 70) tally.drop += 1;
    if (s.sig_volume_collapse >= 70) tally.vol += 1;
    if (s.sig_usage >= 70) tally.usage += 1;
    if (s.sig_billing >= 70) tally.billing += 1;
  }
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!ranked[0] || ranked[0][1] === 0) return "—";
  const label: Record<string, string> = {
    we: "We silent",
    client: "Client silent",
    drop: "Resp drop",
    vol: "Vol collapse",
    usage: "Usage low",
    billing: "Billing",
  };
  return `${label[ranked[0][0]]} (${ranked[0][1]})`;
}

function exportCsv(rows: AmRow[], filename: string) {
  const headers = [
    "AM",
    "Pod",
    "Total",
    "Action_RED",
    "%_RED",
    "RED",
    "YELLOW",
    "GREEN",
    "Avg_Composite",
    "MRR",
    "MRR_at_Risk",
    "Trajectory_Flagged",
    "Top_Signal",
  ];
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        escape(r.am),
        escape(r.pod),
        String(r.total),
        String(r.action),
        r.total ? r.pctRed.toFixed(0) : "0",
        String(r.RED),
        String(r.YELLOW),
        String(r.GREEN),
        String(r.avgComposite),
        String(Math.round(r.mrr)),
        String(Math.round(r.mrrAtRisk)),
        String(r.flagged),
        escape(r.topSignal),
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

function TierSpreadBar({
  red,
  yellow,
  green,
  total,
}: {
  red: number;
  yellow: number;
  green: number;
  total: number;
}) {
  if (total === 0) return <span className="text-[10px] text-zoca-text-3">—</span>;
  const r = (red / total) * 100;
  const y = (yellow / total) * 100;
  const g = (green / total) * 100;
  return (
    <div
      className="flex h-1.5 w-20 overflow-hidden rounded-full"
      style={{ background: "var(--zoca-bg-soft)" }}
      role="img"
      aria-label={`Tier spread: ${red} red, ${yellow} yellow, ${green} green`}
      title={`${red} RED · ${yellow} YEL · ${green} GRN`}
    >
      {r > 0 && <div style={{ width: `${r}%`, background: "var(--zoca-pink)" }} />}
      {y > 0 && <div style={{ width: `${y}%`, background: "var(--zoca-amber)" }} />}
      {g > 0 && <div style={{ width: `${g}%`, background: "var(--zoca-green)" }} />}
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark
        className="rounded px-0.5"
        style={{ background: "rgba(200, 67, 29, 0.18)", color: "var(--zoca-text)" }}
      >
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export default function V2Rollup({ snapshot, initialPod, onJumpToAm }: Props) {
  const [podFilter, setPodFilter] = useState<string>(initialPod || "All");
  const [search, setSearch] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("action");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showZeroBooks, setShowZeroBooks] = useState<boolean>(true);

  // Sync pod filter when the parent switches view (Leadership ↔ Pod view changes initialPod)
  useEffect(() => {
    if (initialPod) setPodFilter(initialPod);
  }, [initialPod]);

  const rows = useMemo<AmRow[]>(() => {
    const byAm = new Map<string, ScoredCustomerV2[]>();
    for (const c of snapshot.customers) {
      // F-purge-churned — snapshot excludes recently-churned rows.
      const am = c.am_name || "";
      if (!am) continue;
      if (!byAm.has(am)) byAm.set(am, []);
      byAm.get(am)!.push(c);
    }
    const allAms = new Set<string>([...ACTIVE_AMS, ...INCOMING_AMS]);
    for (const a of byAm.keys()) allAms.add(a);

    const result: AmRow[] = [];
    for (const am of allAms) {
      const list = byAm.get(am) || [];
      const counts: Record<Stoplight, number> = { RED: 0, YELLOW: 0, GREEN: 0 };
      let mrr = 0;
      let mrrAtRisk = 0;
      let scoreSum = 0;
      let flagged = 0;
      // Phase 33.H.3b — 4-tier counts
      let critical = 0;
      let atRisk = 0;
      let monitor = 0;
      let healthy = 0;
      let mrrAtRiskNeedsCall = 0;
      for (const c of list) {
        const sl = c.signals_v2.stoplight;
        counts[sl] += 1;
        const plan = c.plan_amount || 0;
        mrr += plan;
        if (sl === "RED") mrrAtRisk += plan;
          // Phase 33.H.3b — classify by metabase_health.tier (MONITOR fallback)
          const _htRaw = ((c as any).metabase_health?.health_tier as string | null | undefined) || "";
          const _ht =
            _htRaw === "CRITICAL - DEAL BREAKER" || _htRaw === "CRITICAL" ? "CRITICAL"
            : _htRaw === "AT-RISK" ? "AT-RISK"
            : _htRaw === "HEALTHY" ? "HEALTHY"
            : "MONITOR";
          if (_ht === "CRITICAL") critical += 1;
          else if (_ht === "AT-RISK") atRisk += 1;
          else if (_ht === "HEALTHY") healthy += 1;
          else monitor += 1;
          if (_ht === "CRITICAL" || _ht === "AT-RISK") mrrAtRiskNeedsCall += plan;
        scoreSum += c.signals_v2.composite || 0;
        if (c.performance?.flag) flagged += 1;
      }
      result.push({
        am,
        pod: POD_MAP[am] || "Floating",
        total: list.length,
        RED: counts.RED,
        YELLOW: counts.YELLOW,
        GREEN: counts.GREEN,
        action: counts.RED,
        pctRed: list.length ? (counts.RED / list.length) * 100 : 0,
        mrr,
        mrrAtRisk: mrrAtRiskNeedsCall,
        avgComposite: list.length ? Math.round(scoreSum / list.length) : 0,
        topSignal: classifyTopSignal(list),
          // Phase 33.H.3b — 4-tier fields
          critical,
          atRisk,
          monitor,
          healthy,
          needsCall: critical + atRisk,
          pctNeedsCall: list.length ? ((critical + atRisk) / list.length) * 100 : 0,
        flagged,
      });
    }
    return result;
  }, [snapshot]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (podFilter !== "All" && r.pod !== podFilter) return false;
      if (q && !r.am.toLowerCase().includes(q)) return false;
      if (!showZeroBooks && r.total === 0) return false;
      return true;
    });
  }, [rows, podFilter, search, showZeroBooks]);

  const sorted = useMemo(() => {
    const cp = [...filtered];
    cp.sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      switch (sortKey) {
        case "am":
          av = a.am.toLowerCase();
          bv = b.am.toLowerCase();
          break;
        case "pod":
          av = a.pod;
          bv = b.pod;
          break;
        case "total":
          av = a.total;
          bv = b.total;
          break;
        case "red":
          av = a.needsCall;
          bv = b.needsCall;
          break;
        case "yellow":
          av = a.monitor;
          bv = b.monitor;
          break;
        case "green":
          av = a.healthy;
          bv = b.healthy;
          break;
        case "action":
          av = a.action;
          bv = b.action;
          break;
        case "pctRed":
          av = a.pctNeedsCall;
          bv = b.pctNeedsCall;
          break;
        case "mrr":
          av = a.mrr;
          bv = b.mrr;
          break;
        case "mrrAtRisk":
          av = a.mrrAtRisk;
          bv = b.mrrAtRisk;
          break;
        case "avg":
          av = a.avgComposite;
          bv = b.avgComposite;
          break;
        case "flagged":
          av = a.flagged;
          bv = b.flagged;
          break;
      }
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const an = av as number;
      const bn = bv as number;
      return sortDir === "asc" ? an - bn : bn - an;
    });
    return cp;
  }, [filtered, sortKey, sortDir]);

  const totals = useMemo(() => {
    return sorted.reduce(
      (acc, r) => {
        acc.total += r.total;
        acc.RED += r.RED;
        acc.YELLOW += r.YELLOW;
        acc.GREEN += r.GREEN;
          // Phase 33.H.3b — 4-tier accumulators
          acc.critical += r.critical;
          acc.atRisk += r.atRisk;
          acc.monitor += r.monitor;
          acc.healthy += r.healthy;
          acc.needsCall += r.needsCall;
        acc.action += r.action;
        acc.mrr += r.mrr;
        acc.mrrAtRisk += r.mrrAtRisk;
        return acc;
      },
      { total: 0, RED: 0, YELLOW: 0, GREEN: 0, critical: 0, atRisk: 0, monitor: 0, healthy: 0, needsCall: 0, action: 0, mrr: 0, mrrAtRisk: 0 },
    );
  }, [sorted]);

  const filtersActive =
    podFilter !== "All" || search.trim().length > 0 || !showZeroBooks;

  const clearFilters = () => {
    setPodFilter("All");
    setSearch("");
    setShowZeroBooks(true);
  };

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "am" || key === "pod" ? "asc" : "desc");
    }
  };

  const handleExportCsv = () => {
    const date = new Date(snapshot.generatedAt).toISOString().slice(0, 10);
    const podSuffix = podFilter !== "All" ? `_${podFilter.replace(/\s+/g, "-")}` : "";
    exportCsv(sorted, `zoca_rollup_${date}${podSuffix}.csv`);
  };

  const liveLabel = `Showing ${sorted.length} AMs, ${totals.total} customers, ${totals.needsCall} needs call`;

  return (
    <section aria-label="Cross-AM rollup">
      {/* Header */}
      <header className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            className="font-extrabold text-zoca-text"
            style={{ fontSize: "20px", letterSpacing: "-0.02em" }}
          >
            Manager rollup
          </h2>
          <p className="mt-1 text-xs text-zoca-text-2">
            {totals.total} customers across {sorted.length} AM
            {sorted.length === 1 ? "" : "s"}
            {podFilter !== "All" ? ` · filtered to ${podFilter}` : ""}
            {search.trim() ? ` · search "${search}"` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            placeholder="Search AM…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearch("");
            }}
            aria-label="Search account managers by name"
            className="w-44 rounded-full border px-3 py-1.5 text-[13px] focus:outline-none"
            // Phase 33.brand-watchfire-T6 — search input on Light Parchment.
            style={{
              borderColor: "var(--zoca-border)",
              background: "var(--zoca-bg-soft)",
              color: "var(--zoca-text)",
            }}
          />
          <button
            onClick={handleExportCsv}
            disabled={sorted.length === 0}
            aria-label="Download current view as CSV"
            title="Download current view as CSV"
            className="zoca-btn zoca-btn-outline disabled:cursor-not-allowed disabled:opacity-50"
            style={{ padding: "6px 14px", fontSize: "12px" }}
          >
            <span aria-hidden>↓</span> CSV
          </button>
        </div>
      </header>

      {/* Pod filter chips + secondary controls */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Pod filter">
          {POD_OPTIONS.map((p) => {
            const active = podFilter === p;
            const dot = POD_COLOR_DOT[p];
            return (
              <button
                key={p}
                onClick={() => setPodFilter(p)}
                aria-pressed={active}
                aria-label={`Filter to ${p}`}
                className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition focus:outline-none"
                style={
                  active
                    ? {
                        borderColor: "var(--zoca-pink)",
                        background:
                          "linear-gradient(180deg, rgba(200, 67, 29, 0.06), rgba(252, 228, 214, 0.08))",
                        color: "var(--zoca-text)",
                      }
                    : {
                        // Phase 33.brand-watchfire-T6 — pod chip on Light Parchment.
                        borderColor: "var(--zoca-border)",
                        background: "var(--zoca-bg-soft)",
                        color: "var(--zoca-text-2)",
                      }
                }
              >
                {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />}
                {p}
              </button>
            );
          })}
        </div>
        <label
          className="ml-1 inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-zoca-text-2 hover:text-zoca-text"
          title="Hide AMs with no active customers (e.g. incoming AMs)"
        >
          <input
            type="checkbox"
            checked={showZeroBooks}
            onChange={(e) => setShowZeroBooks(e.target.checked)}
            className="h-3 w-3 cursor-pointer"
            style={{ accentColor: "var(--zoca-pink)" }}
            aria-label="Show AMs with empty books"
          />
          Show empty books
        </label>
        {filtersActive && (
          <button
            onClick={clearFilters}
            className="ml-auto text-[11px] font-semibold underline-offset-2 hover:underline focus:outline-none"
            style={{ color: "var(--zoca-pink)" }}
            aria-label="Clear all filters"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Aggregate strip — Phase 17.E: white card with stoplight-tinted numbers */}
      <div
        className="zoca-card mt-4 grid grid-cols-2 gap-2 sm:grid-cols-6"
        style={{ padding: "14px 16px" }}
      >
        <div>
          <div className="zoca-micro-label">Customers</div>
          <div
            className="mt-0.5 font-extrabold tabular-nums text-zoca-text"
            style={{ fontSize: "18px", letterSpacing: "-0.02em" }}
          >
            {totals.total}
          </div>
        </div>
        <div>
          <div className="zoca-micro-label">Needs call</div>
          <div
            className="mt-1 font-extrabold tabular-nums"
            style={{ fontSize: "18px", letterSpacing: "-0.02em", color: "var(--zoca-pink)" }}
          >
            {totals.RED}
          </div>
        </div>
        <div>
          <div className="zoca-micro-label">Monitor</div>
          <div
            className="mt-1 font-extrabold tabular-nums"
            style={{ fontSize: "18px", letterSpacing: "-0.02em", color: "var(--zoca-amber)" }}
          >
            {totals.monitor}
          </div>
        </div>
        <div>
          <div className="zoca-micro-label">Healthy</div>
          <div
            className="mt-1 font-extrabold tabular-nums"
            style={{ fontSize: "18px", letterSpacing: "-0.02em", color: "var(--zoca-green)" }}
          >
            {totals.healthy}
          </div>
        </div>
        <div title="Total MRR across the customers shown">
          <div className="zoca-micro-label">MRR</div>
          <div
            className="mt-0.5 font-extrabold tabular-nums text-zoca-text"
            style={{ fontSize: "18px", letterSpacing: "-0.02em" }}
          >
            {formatMoney(totals.mrr)}
          </div>
        </div>
        <div title="MRR carried by Critical + At-risk customers — the dollars actively at risk this week">
          <div className="zoca-micro-label">MRR at risk</div>
          <div
            className="mt-1 font-extrabold tabular-nums"
            style={{ fontSize: "18px", letterSpacing: "-0.02em", color: "var(--zoca-pink)" }}
          >
            {formatMoney(totals.mrrAtRisk)}
          </div>
        </div>
      </div>

      {/* Aria-live region for sorted/filtered changes */}
      <div className="sr-only" role="status" aria-live="polite">
        {liveLabel}
      </div>

      {/* Table */}
      <div
        // Phase 33.brand-watchfire-T6 — rollup table on Light Parchment.
        className="mt-4 overflow-x-auto rounded-2xl border"
        style={{ borderColor: "var(--zoca-border)", background: "var(--zoca-bg-soft)" }}
      >
        <table className="min-w-full divide-y text-[13px]" style={{ borderColor: "var(--zoca-border)" }}>
          <thead
            className="text-left text-[10px] uppercase tracking-wider"
            style={{ background: "var(--zoca-bg-soft)", color: "var(--zoca-text-2)" }}
          >
            <tr>
              <Th label="AM" col="am" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
              <Th label="Pod" col="pod" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
              <Th
                label="Total"
                col="total"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={toggleSort}
                align="right"
              />
              <th className="px-3 py-2 text-left font-semibold" scope="col">
                Spread
              </th>
              <Th
                label="Action"
                col="action"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={toggleSort}
                align="right"
                tooltip="Customers needing action today (Critical + At-risk). Click to sort."
              />
              <Th
                label="% NEEDS CALL"
                col="pctRed"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={toggleSort}
                align="right"
                tooltip="Needs-call (Critical + At-risk) as a percentage of the AM's book. Compares fairly across books of different sizes."
              />
              <Th
                label="NEEDS CALL"
                col="red"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={toggleSort}
                align="right"
              />
              <Th
                label="MONITOR"
                col="yellow"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={toggleSort}
                align="right"
              />
              <Th
                label="HEALTHY"
                col="green"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={toggleSort}
                align="right"
              />
              <Th
                label="Avg"
                col="avg"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={toggleSort}
                align="right"
                tooltip="Average composite score (0-100, higher = healthier)"
              />
              <Th
                label="MRR"
                col="mrr"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={toggleSort}
                align="right"
              />
              <Th
                label="MRR @ risk"
                col="mrrAtRisk"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={toggleSort}
                align="right"
                tooltip="Sum of plan_amount for Critical + At-risk customers in this book."
              />
              <Th
                label={"⛑"}
                col="flagged"
                sortKey={sortKey}
                sortDir={sortDir}
                onClick={toggleSort}
                align="right"
                tooltip="Customers with performance trajectory flag (GBP drop, zero-review weeks, or YTD lead decline)."
              />
              {/* F-purge-churned — Churned 30d column removed; churn no longer surfaces on the book. */}
              <th
                className="px-3 py-2 text-left font-semibold"
                scope="col"
                title={SIGNAL_HELP}
              >
                <span className="inline-flex items-center gap-1">
                  Top signal
                  <span
                    className="text-zoca-text-3"
                    aria-label="Help: top signal definitions"
                  >
                    ⓘ
                  </span>
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y" style={{ borderColor: "var(--zoca-border)" }}>
            {sorted.length === 0 && (
              <tr>
                <td
                  colSpan={15}
                  className="px-4 py-10 text-center text-sm text-zoca-text-2"
                >
                  {search.trim()
                    ? `No AMs match "${search}".`
                    : podFilter !== "All"
                      ? `No AMs in ${podFilter}.`
                      : "No customers in snapshot."}
                </td>
              </tr>
            )}
            {sorted.map((r) => (
              <tr
                key={r.am}
                className="group transition"
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--zoca-bg-soft)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <td className="px-3 py-2.5">
                  <AmLink amName={r.am} className="text-left font-medium" style={{ color: "var(--zoca-text)" }}>
                    <Highlight text={r.am} query={search} />
                  </AmLink>
                </td>
                <td className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-1.5 text-zoca-text-2">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${POD_COLOR_DOT[r.pod] || "bg-slate-500"}`}
                      aria-hidden
                    />
                    {r.pod}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-zoca-text">
                  {r.total || <span className="text-zoca-text-3">·</span>}
                </td>
                <td className="px-3 py-2.5">
                  <TierSpreadBar
                    red={r.needsCall}
                    yellow={r.monitor}
                    green={r.healthy}
                    total={r.total}
                  />
                </td>
                <td
                  className="px-3 py-2.5 text-right tabular-nums"
                  title={r.total ? `${r.pctNeedsCall.toFixed(0)}% of ${r.total}` : "No customers"}
                >
                  {r.action > 0 ? (
                    <span
                      className="inline-flex items-center rounded-full px-2 py-0.5 font-semibold"
                      style={{
                        background: "rgba(124, 45, 18, 0.12)",
                        color: "var(--zoca-pink-bright)",
                        border: "1px solid rgba(200, 67, 29, 0.22)",
                      }}
                    >
                      {r.action}
                    </span>
                  ) : (
                    <span className="text-zoca-text-3">0</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-zoca-text-2">
                  {r.total ? (
                    `${r.pctNeedsCall.toFixed(0)}%`
                  ) : (
                    <span className="text-zoca-text-3">·</span>
                  )}
                </td>
                <td
                  className="px-3 py-2.5 text-right tabular-nums"
                  style={{ color: "var(--zoca-pink)" }}
                >
                  {r.needsCall > 0 ? (
                    <AmLink amName={r.am} filter="act" showArrow={false} style={{ color: "var(--zoca-pink)" }}>
                      {r.needsCall}
                    </AmLink>
                  ) : (
                    <span className="text-zoca-text-3">·</span>
                  )}
                </td>
                <td
                  className="px-3 py-2.5 text-right tabular-nums"
                  style={{ color: "var(--zoca-amber)" }}
                >
                  {r.monitor || <span className="text-zoca-text-3">·</span>}
                </td>
                <td
                  className="px-3 py-2.5 text-right tabular-nums"
                  style={{ color: "var(--zoca-green)" }}
                >
                  {r.healthy || <span className="text-zoca-text-3">·</span>}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-zoca-text-2">
                  {r.avgComposite || <span className="text-zoca-text-3">·</span>}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-zoca-text">
                  {r.mrr ? formatMoney(r.mrr) : <span className="text-zoca-text-3">·</span>}
                </td>
                <td
                  className="px-3 py-2.5 text-right tabular-nums"
                  style={{ color: "var(--zoca-pink)" }}
                >
                  {r.mrrAtRisk ? (
                    formatMoney(r.mrrAtRisk)
                  ) : (
                    <span className="text-zoca-text-3">·</span>
                  )}
                </td>
                <td
                  className="px-3 py-2.5 text-right tabular-nums"
                  title={r.flagged ? `${r.flagged} of ${r.total} flagged (${((r.flagged / Math.max(r.total, 1)) * 100).toFixed(0)}%)` : "No performance flags"}
                >
                  {r.flagged > 0 ? (
                    <span
                      className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 font-semibold"
                      style={{
                        background: "rgba(124, 45, 18, 0.12)",
                        color: "var(--zoca-pink-bright)",
                        border: "1px solid rgba(200, 67, 29, 0.22)",
                      }}
                    >
                      {"⛑"} {r.flagged}
                    </span>
                  ) : (
                    <span className="text-zoca-text-3">·</span>
                  )}
                </td>
                {/* F-purge-churned — Churned 30d body cell removed */}
                <td className="px-3 py-2.5 text-zoca-text-2">{r.topSignal}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] text-zoca-text-2">
        Click an AM name to drill into their book. Click any column header to sort. Pod filter,
        search, and "show empty books" all stack.
      </p>
    </section>
  );
}

function Th({
  label,
  col,
  sortKey,
  sortDir,
  onClick,
  align,
  tooltip,
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
  align?: "left" | "right";
  tooltip?: string;
}) {
  const active = sortKey === col;
  const arrow = active ? (sortDir === "asc" ? "↑" : "↓") : "";
  return (
    <th
      className={`px-3 py-2 font-semibold ${align === "right" ? "text-right" : "text-left"}`}
      scope="col"
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        onClick={() => onClick(col)}
        className="inline-flex items-center gap-1 transition focus:outline-none"
        style={{ color: active ? "var(--zoca-text)" : "var(--zoca-text-2)" }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--zoca-text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = active ? "var(--zoca-text)" : "var(--zoca-text-2)";
        }}
        aria-label={`Sort by ${label}${active ? `, currently ${sortDir === "asc" ? "ascending" : "descending"}` : ""}`}
        title={tooltip || `Sort by ${label}`}
      >
        {label}
        {arrow && <span aria-hidden>{arrow}</span>}
      </button>
    </th>
  );
}
