"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (5 hex/rgba + 0 tailwind-rose swept)

import { useEffect, useMemo, useState, useRef } from "react";
import dynamic from "next/dynamic";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Filler,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import type { ScoredCustomer, Snapshot } from "@/lib/customer/types";
import type { Tier } from "@/lib/customer/config";
import { TIER_COLORS, TIER_ORDER, CHANNEL_COLORS } from "@/lib/customer/config";

import { useActivityLogger } from "@/lib/customer/hooks/use-activity-logger";
ChartJS.register(
  CategoryScale, LinearScale, BarElement, LineElement, PointElement,
  ArcElement, Filler, Title, Tooltip, Legend,
);
if (typeof window !== "undefined") {
  ChartJS.defaults.color = "#c8cafe";
  ChartJS.defaults.borderColor = "rgba(200, 202, 254, 0.12)";
  ChartJS.defaults.font.family = "var(--font-inter), Inter, sans-serif";
}

const Bar      = dynamic(() => import("react-chartjs-2").then((m) => m.Bar),      { ssr: false });
const Line     = dynamic(() => import("react-chartjs-2").then((m) => m.Line),     { ssr: false });
const Doughnut = dynamic(() => import("react-chartjs-2").then((m) => m.Doughnut), { ssr: false });
const Bubble   = dynamic(() => import("react-chartjs-2").then((m) => m.Bubble),   { ssr: false });

/* =================================================================== types */

type TabKey = "overview" | "tiers" | "signals" | "ams" | "risk_list" | "all";
const TABS: { key: TabKey; label: string }[] = [
  { key: "overview",  label: "Overview" },
  { key: "tiers",     label: "Risk Tiers" },
  { key: "signals",   label: "Signals" },
  { key: "ams",       label: "AM Exposure" },
  { key: "risk_list", label: "HIGH-risk list" },
  { key: "all",       label: "All customers" },
];

type WindowDays = 7 | 14 | 30 | 60 | 90;
const WINDOW_OPTIONS: WindowDays[] = [7, 14, 30, 60, 90];

type SortKey = null | "score" | "comms_window" | "ratio" | "active_in_window";
type Filters = {
  tier: Tier | null;
  am: string | null;
  signal: "ws" | "cs" | "rd" | "vc" | null;
  search: string;
  windowDays: WindowDays;
  sort: SortKey;          // when set, RiskList sorts by this key
  activeInWindow: boolean; // when true, RiskList only shows customers with > 0 comms in chosen window
  scoreBucket: number | null; // 0–9 → 0-10, 10-20, … 90-100
  channel: string | null;     // chat/email/phone/video/sms — must have used this channel in window
};
const emptyFilters = (): Filters => ({
  tier: null, am: null, signal: null, search: "", windowDays: 30,
  sort: null, activeInWindow: false, scoreBucket: null, channel: null,
});

// Pull the right per-window metrics off a customer regardless of which window is active.
function windowMetrics(m: ScoredCustomer["metrics"], w: WindowDays) {
  switch (w) {
    case 7:  return { total: m.total_7d,  in: m.in_7d,  out: m.out_7d,  channels: m.channels_7d };
    case 14: return { total: m.total_14d, in: m.in_14d, out: m.out_14d, channels: m.channels_14d };
    case 30: return { total: m.total_30d, in: m.in_30d, out: m.out_30d, channels: m.channels_30d };
    case 60: return { total: m.total_60d, in: m.in_60d, out: m.out_60d, channels: m.channels_60d };
    case 90: return { total: m.total_90d, in: m.in_90d, out: m.out_90d, channels: m.channels_90d };
  }
}

/* ================================================================= helpers */

function cls(...p: (string | false | null | undefined)[]) {
  return p.filter(Boolean).join(" ");
}

function fmtDaysSince(d: number): string {
  if (d === 9999 || d == null) return "Never";
  if (d === 0) return "Today";
  if (d === 1) return "1d";
  return d + "d";
}

function scoreColor(s: number): string {
  if (s >= 65) return "#7C2D12";
  if (s >= 35) return "#ffb74d";
  if (s >= 15) return "#7868f4";
  return "#76FF03";
}

function pctOf(n: number, total: number): string {
  if (!total) return "0";
  return ((n / total) * 100).toFixed(1);
}

const SCORE_BUCKET_LABELS = ["0-10", "10-20", "20-30", "30-40", "40-50", "50-60", "60-70", "70-80", "80-90", "90-100"] as const;
function scoreBucketColor(i: number): string {
  const mid = i * 10 + 5;
  if (mid >= 65) return "#7C2D12";
  if (mid >= 35) return "#ffb74d";
  if (mid >= 15) return "#7868f4";
  return "#76FF03";
}

/** Aggregates derived from a (possibly-filtered) customer list. */
type ViewSnap = {
  customers: ScoredCustomer[];
  totalActive: number;
  tierCounts: Record<Tier, number>;
  signalCounts: { we_silent_any: number; client_silent_any: number; response_drop_any: number; volume_collapse_any: number };
  channelCounts: { d30: Record<string, number>; d90: Record<string, number> };
  amExposure: { am: string; high: number; total: number }[];
  amTierBreakdown: { am: string; HIGH: number; MEDIUM: number; LOW: number; HEALTHY: number; total: number }[];
  scoreDistribution: number[];
};

function computeViewAggregates(snap: Snapshot, customers: ScoredCustomer[]): ViewSnap {
  const tierCounts: Record<Tier, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, HEALTHY: 0 };
  for (const c of customers) tierCounts[c.signals.tier]++;

  const signalCounts = {
    we_silent_any: customers.filter((r) => r.signals.sig_we_silent >= 30).length,
    client_silent_any: customers.filter((r) => r.signals.sig_client_silent >= 30).length,
    response_drop_any: customers.filter((r) => r.signals.sig_response_drop >= 30).length,
    volume_collapse_any: customers.filter((r) => r.signals.sig_volume_collapse >= 30).length,
  };

  // Channel counts: only have data for 30d and 90d on the snapshot. Other windows
  // are approximated by reading per-customer channel breadth.
  const channelCounts = { d30: {} as Record<string, number>, d90: {} as Record<string, number> };
  for (const c of customers) {
    for (const ch of (c.metrics.channels_used_30d || "").split(",").filter(Boolean)) {
      channelCounts.d30[ch] = (channelCounts.d30[ch] || 0) + 1;
    }
    for (const ch of (c.metrics.channels_used_90d || "").split(",").filter(Boolean)) {
      channelCounts.d90[ch] = (channelCounts.d90[ch] || 0) + 1;
    }
  }

  const amMap = new Map<string, { high: number; total: number }>();
  const amBreakdownMap = new Map<string, { am: string; HIGH: number; MEDIUM: number; LOW: number; HEALTHY: number; total: number }>();
  for (const c of customers) {
    const am = c.am_name || "(unassigned)";
    const cur = amMap.get(am) || { high: 0, total: 0 };
    cur.total++;
    if (c.signals.tier === "HIGH") cur.high++;
    amMap.set(am, cur);

    const row = amBreakdownMap.get(am) || { am, HIGH: 0, MEDIUM: 0, LOW: 0, HEALTHY: 0, total: 0 };
    row[c.signals.tier]++;
    row.total++;
    amBreakdownMap.set(am, row);
  }
  const amExposure = Array.from(amMap, ([am, v]) => ({ am, ...v })).sort((a, b) => (b.high - a.high) || (b.total - a.total));
  const amTierBreakdown = Array.from(amBreakdownMap.values()).sort((a, b) => (b.HIGH - a.HIGH) || (b.total - a.total));

  const scoreDistribution: number[] = new Array(10).fill(0);
  for (const c of customers) {
    const s = Math.max(0, Math.min(99, c.signals.score));
    scoreDistribution[Math.floor(s / 10)]++;
  }

  return {
    customers,
    totalActive: customers.length,
    tierCounts,
    signalCounts,
    channelCounts,
    amExposure,
    amTierBreakdown,
    scoreDistribution,
  };
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(rows: ScoredCustomer[]) {
  const cols = [
    "score", "tier", "company", "am_name", "cb_status", "auto_collection",
    "plan_amount", "mrr_basesheet", "zoca_status",
    "sig_we_silent", "sig_client_silent", "sig_response_drop", "sig_volume_collapse",
    "days_since_out", "days_since_in",
    "total_7d", "total_14d", "total_30d", "total_60d", "total_90d",
    "in_30d", "out_30d", "in_90d", "out_90d",
    "channels_30d", "channels_90d",
    "notes", "email", "phone", "customer_id", "entity_id",
  ];
  const header = cols.join(",");
  const lines = rows.map((r) => [
    r.signals.score, r.signals.tier, r.company, r.am_name, r.cb_status, r.auto_collection,
    r.plan_amount, r.mrr_basesheet, r.zoca_status,
    r.signals.sig_we_silent, r.signals.sig_client_silent, r.signals.sig_response_drop, r.signals.sig_volume_collapse,
    r.metrics.days_since_out, r.metrics.days_since_in,
    r.metrics.total_7d, r.metrics.total_14d, r.metrics.total_30d, r.metrics.total_60d, r.metrics.total_90d,
    r.metrics.in_30d, r.metrics.out_30d, r.metrics.in_90d, r.metrics.out_90d,
    r.metrics.channels_used_30d, r.metrics.channels_used_90d,
    r.signals.notes, r.email, r.phone, r.customer_id, r.entity_id,
  ].map(csvEscape).join(","));
  const body = "\ufeff" + header + "\n" + lines.join("\n");
  const blob = new Blob([body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `disengagement_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ================================================================== root */

export default function Dashboard() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("overview");
  const [filters, setFilters] = useState<Filters>(emptyFilters());
  // Phase 33.B.9 — debounced filter_changed logger
  const logEvent = useActivityLogger();
  const filterLogFirstRunRef = useRef(true);
  useEffect(() => {
    if (filterLogFirstRunRef.current) {
      filterLogFirstRunRef.current = false;
      return;
    }
    const id = setTimeout(() => {
      logEvent("filter_changed", {
        surface: "v2_dashboard",
        metadata: {
          tier: filters.tier ?? null,
          am: filters.am ?? null,
          signal: filters.signal ?? null,
          windowDays: filters.windowDays,
          sort: filters.sort ?? null,
          hasSearch: !!(filters.search && filters.search.length > 0),
        },
      });
    }, 500);
    return () => clearTimeout(id);
  }, [filters, logEvent]);
  const [modal, setModal] = useState<ScoredCustomer | null>(null);

  async function load(rebuild = false) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/snapshot${rebuild ? "?rebuild=1" : ""}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      setSnap(json as Snapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }
  useEffect(() => { load(false); }, []);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/snapshot?rebuild=1`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      setSnap(json as Snapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  /* -------- derived: filtered + sorted customer list -------- */
  const filteredCustomers = useMemo(() => {
    if (!snap) return [];
    const q = filters.search.trim().toLowerCase();
    const channelWindowKey = filters.windowDays >= 60 ? "channels_used_90d" : "channels_used_30d";
    const filtered = snap.customers.filter((c) => {
      if (filters.tier && c.signals.tier !== filters.tier) return false;
      if (filters.am && (c.am_name || "(unassigned)") !== filters.am) return false;
      if (filters.signal === "ws" && c.signals.sig_we_silent < 30) return false;
      if (filters.signal === "cs" && c.signals.sig_client_silent < 30) return false;
      if (filters.signal === "rd" && c.signals.sig_response_drop < 30) return false;
      if (filters.signal === "vc" && c.signals.sig_volume_collapse < 30) return false;
      if (filters.activeInWindow && windowMetrics(c.metrics, filters.windowDays).total <= 0) return false;
      if (filters.scoreBucket !== null) {
        const lo = filters.scoreBucket * 10;
        const hi = lo + 10;
        if (c.signals.score < lo || c.signals.score >= hi) return false;
      }
      if (filters.channel) {
        const channels = (c.metrics[channelWindowKey] || "").split(",").filter(Boolean);
        if (!channels.includes(filters.channel)) return false;
      }
      if (q) {
        const hay = `${c.company} ${c.am_name} ${c.email} ${c.customer_id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // Apply sort if set; otherwise keep snapshot order (already by score desc)
    if (filters.sort === "comms_window") {
      filtered.sort((a, b) => windowMetrics(b.metrics, filters.windowDays).total - windowMetrics(a.metrics, filters.windowDays).total);
    } else if (filters.sort === "ratio") {
      const ratio = (c: ScoredCustomer) => {
        const w = windowMetrics(c.metrics, filters.windowDays);
        return w.out > 0 ? w.in / w.out : (w.in > 0 ? Infinity : -1);
      };
      filtered.sort((a, b) => ratio(b) - ratio(a));
    } else if (filters.sort === "active_in_window") {
      filtered.sort((a, b) => windowMetrics(b.metrics, filters.windowDays).total - windowMetrics(a.metrics, filters.windowDays).total);
    } else if (filters.sort === "score") {
      filtered.sort((a, b) => b.signals.score - a.signals.score);
    }
    return filtered;
  }, [snap, filters]);

  /* -------- derived: aggregates for the filtered set -------- */
  const viewSnap = useMemo(() => {
    if (!snap) return null;
    return computeViewAggregates(snap, filteredCustomers);
  }, [snap, filteredCustomers]);

  /* -------- state views -------- */
  if (loading && !snap) return <LoadingPane />;
  if (error && !snap) return <ErrorPane error={error} onRetry={() => load(true)} />;
  if (!snap) return null;

  return (
    <div className="space-y-4">
      {/* Top bar: filters + controls — uses a 12-col grid so every cell aligns
          regardless of select width. Mobile collapses to stacked rows. */}
      <div className="rounded-zoca-xl border border-zoca-border-2 bg-zoca-bg-2/55 p-3 backdrop-blur-sm">
        <div className="grid grid-cols-1 items-center gap-3 lg:grid-cols-12">
          <input
            type="search"
            placeholder="Search biz name, AM, email…"
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            className="rounded-zoca-pill border border-zoca-border-2 bg-zoca-bg-3/50 px-4 py-2 text-sm text-white placeholder:text-zoca-text-soft focus:border-zoca-pink-1 focus:outline-none lg:col-span-3"
          />
          <select
            value={filters.tier || ""}
            onChange={(e) => setFilters({ ...filters, tier: (e.target.value || null) as Tier | null })}
            className="rounded-zoca-pill border border-zoca-border-2 bg-zoca-bg-3/50 px-3 py-2 text-sm text-white lg:col-span-2"
          >
            <option value="">All tiers</option>
            {TIER_ORDER.map((t) => <option key={t} value={t}>{t} · {snap.tierCounts[t] || 0}</option>)}
          </select>
          <select
            value={filters.am || ""}
            onChange={(e) => setFilters({ ...filters, am: e.target.value || null })}
            className="rounded-zoca-pill border border-zoca-border-2 bg-zoca-bg-3/50 px-3 py-2 text-sm text-white lg:col-span-2"
          >
            <option value="">All AMs</option>
            {snap.amExposure.map(({ am, total }) => <option key={am} value={am}>{am} · {total}</option>)}
          </select>
          <select
            value={filters.signal || ""}
            onChange={(e) => setFilters({ ...filters, signal: (e.target.value || null) as Filters["signal"] })}
            className="rounded-zoca-pill border border-zoca-border-2 bg-zoca-bg-3/50 px-3 py-2 text-sm text-white lg:col-span-3"
          >
            <option value="">All signals</option>
            <option value="ws">We went silent</option>
            <option value="cs">Client went silent</option>
            <option value="rd">Response rate dropped</option>
            <option value="vc">Volume/channel collapse</option>
          </select>
          <select
            value={String(filters.windowDays)}
            onChange={(e) => setFilters({ ...filters, windowDays: Number(e.target.value) as WindowDays })}
            className="rounded-zoca-pill border border-zoca-border-2 bg-zoca-bg-3/50 px-3 py-2 text-sm text-white lg:col-span-2"
            title="Time window for comms-volume charts (does not affect tier scoring)"
          >
            {WINDOW_OPTIONS.map((w) => <option key={w} value={w}>Last {w} days</option>)}
          </select>
        </div>

        {/* Status + actions row — clean baseline alignment, right-aligned */}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-3 border-t border-zoca-border pt-3">
          <div className="mr-auto text-xs text-zoca-text-soft">
            <span className="font-semibold uppercase tracking-[0.1em] text-zoca-text-soft">Showing</span>{" "}
            <strong className="text-zoca-pink-text">{filteredCustomers.length.toLocaleString()}</strong>
            <span className="text-zoca-text-soft"> / {snap.totalActive.toLocaleString()} · last refresh </span>
            <span className="text-white">{snap.generatedAt.slice(11, 19)}Z · {snap.generatedAt.slice(0, 10)}</span>
          </div>
          <button
            className="zoca-btn zoca-btn-ghost"
            onClick={() => downloadCsv(filteredCustomers)}
            disabled={!filteredCustomers.length}
            title="Export the filtered list to CSV"
          >
            ⇣ CSV
          </button>
          <button
            className="zoca-btn"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Re-score from live Chargebee + Metabase now"
          >
            <span className={refreshing ? "refresh-spinning" : ""}>↻</span>
            {refreshing ? "Refreshing…" : "Refresh live data"}
          </button>
        </div>
      </div>

      {/* Active filter chips */}
      {(filters.tier || filters.am || filters.signal || filters.activeInWindow || filters.sort || filters.scoreBucket !== null || filters.channel) && (
        <div className="flex flex-wrap items-center gap-2">
          {filters.tier && <FilterChip label={`tier: ${filters.tier}`} onClear={() => setFilters({ ...filters, tier: null })} />}
          {filters.am && <FilterChip label={`AM: ${filters.am}`} onClear={() => setFilters({ ...filters, am: null })} />}
          {filters.signal && <FilterChip label={`signal: ${filters.signal}`} onClear={() => setFilters({ ...filters, signal: null })} />}
          {filters.activeInWindow && <FilterChip label={`active in last ${filters.windowDays}d`} onClear={() => setFilters({ ...filters, activeInWindow: false })} />}
          {filters.scoreBucket !== null && <FilterChip label={`score ${filters.scoreBucket * 10}–${filters.scoreBucket * 10 + 10}`} onClear={() => setFilters({ ...filters, scoreBucket: null })} />}
          {filters.channel && <FilterChip label={`channel: ${filters.channel}`} onClear={() => setFilters({ ...filters, channel: null })} />}
          {filters.sort && <FilterChip label={`sort: ${filters.sort.replace("_", " ")}`} onClear={() => setFilters({ ...filters, sort: null })} />}
          <button
            className="text-xs text-zoca-text-soft underline-offset-2 hover:text-white hover:underline"
            onClick={() => setFilters(emptyFilters())}
          >
            reset all
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cls(
              "rounded-zoca-pill border px-4 py-1.5 text-sm font-medium transition",
              tab === t.key
                ? "border-zoca-pink-1 bg-zoca-pink-1/10 text-white"
                : "border-zoca-border-2 bg-zoca-bg-2/40 text-zoca-text-muted hover:border-zoca-border-3 hover:text-white",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab body — viewSnap recomputes aggregates from the filtered customer list
          so every chart + card reacts to tier / AM / signal / search filters.
          windowDays drives the rolling-window selector for comms-volume charts. */}
      {tab === "overview" && <Overview snap={snap} viewSnap={viewSnap} windowDays={filters.windowDays} setTab={setTab} setFilters={setFilters} openDetail={setModal} currentFilters={filters} />}
      {tab === "tiers" && <TiersView viewSnap={viewSnap} setFilters={setFilters} setTab={setTab} />}
      {tab === "signals" && <SignalsView viewSnap={viewSnap} setFilters={setFilters} setTab={setTab} />}
      {tab === "ams" && <AmExposureView viewSnap={viewSnap} setFilters={setFilters} setTab={setTab} />}
      {tab === "risk_list" && <RiskList customers={filteredCustomers.length ? filteredCustomers : snap.customers.filter((c) => c.signals.tier === "HIGH")} windowDays={filters.windowDays} openDetail={setModal} />}
      {tab === "all" && <RiskList customers={filteredCustomers} windowDays={filters.windowDays} openDetail={setModal} />}

      {modal && <CustomerModal customer={modal} onClose={() => setModal(null)} />}
    </div>
  );
}

/* ================================================================= views */

function Overview({
  snap, viewSnap, windowDays, setTab, setFilters, openDetail, currentFilters,
}: {
  snap: Snapshot;
  viewSnap: ViewSnap | null;
  windowDays: WindowDays;
  setTab: (k: TabKey) => void;
  setFilters: (f: Filters) => void;
  openDetail: (c: ScoredCustomer) => void;
  currentFilters: Filters;
}) {
  if (!viewSnap) return null;
  const tc = viewSnap.tierCounts;
  const total = viewSnap.totalActive || 1;
  const sig = viewSnap.signalCounts;
  const h = snap.health;
  // Channel-usage chart can only show 30d / 90d aggregates from the snapshot.
  // For windowDays of 7 / 14 / 60, fall back to the closest aggregate.
  const channelWindow: 30 | 90 = windowDays >= 60 ? 90 : 30;

  return (
    <div className="space-y-4">
      {/* ---- Data Health strip ---- */}
      <Card className="zoca-fade-in !p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <HealthStat label="Active customers" value={snap.totalActive.toLocaleString()} />
          <HealthStat
            label="Entity-ID matched"
            value={`${h.customersWithEntityId.toLocaleString()} · ${pctOf(h.customersWithEntityId, snap.totalActive)}%`}
            ok={h.customersWithEntityId / Math.max(1, snap.totalActive) >= 0.9}
            sub={h.matchBreakdown ? `${h.matchBreakdown.byCustomerId} by ID · ${h.matchBreakdown.byBizName} by name` : undefined}
          />
          <HealthStat
            label="Any comms (90d)"
            value={`${h.customersWithAnyComms90d.toLocaleString()} · ${pctOf(h.customersWithAnyComms90d, snap.totalActive)}%`}
            ok={h.customersWithAnyComms90d / Math.max(1, snap.totalActive) >= 0.5}
          />
          <HealthStat
            label="Comms events"
            value={(h.perDirectionCount.in + h.perDirectionCount.out).toLocaleString()}
            sub={`${h.perDirectionCount.in.toLocaleString()} in · ${h.perDirectionCount.out.toLocaleString()} out`}
          />
          <HealthStat
            label="Refresh"
            value={`${(h.refreshDurationMs / 1000).toFixed(1)}s`}
            ok={h.fetchErrors.length === 0}
            sub={h.fetchErrors.length ? `${h.fetchErrors.length} error(s)` : "OK"}
          />
          <HealthStat
            label="Per-source events"
            value={`${h.perSourceEventCount.chat.toLocaleString()} chat`}
            sub={`${h.perSourceEventCount.phone} phone · ${h.perSourceEventCount.video} vid · ${h.perSourceEventCount.sms} sms · ${h.perSourceEventCount.email} email`}
          />
        </div>
        {h.perSourceRawRows && (
          <div className="mt-3 grid gap-2 rounded-zoca-lg border border-zoca-border bg-zoca-bg-3/30 p-3 text-[11px] sm:grid-cols-6">
            <div className="text-zoca-text-soft">Raw CSV rows →</div>
            <div><span className="text-zoca-text-soft">chat</span> <strong className="text-white">{h.perSourceRawRows.chat.toLocaleString()}</strong></div>
            <div><span className="text-zoca-text-soft">email</span> <strong className="text-white">{h.perSourceRawRows.email.toLocaleString()}</strong></div>
            <div><span className="text-zoca-text-soft">phone</span> <strong className="text-white">{h.perSourceRawRows.phone.toLocaleString()}</strong></div>
            <div><span className="text-zoca-text-soft">video</span> <strong className="text-white">{h.perSourceRawRows.video.toLocaleString()}</strong></div>
            <div><span className="text-zoca-text-soft">sms</span> <strong className="text-white">{h.perSourceRawRows.sms.toLocaleString()}</strong></div>
          </div>
        )}
        {h.duplicateEventsRemoved !== undefined && h.duplicateEventsRemoved > 0 && (
          <div className="mt-2 rounded-zoca border border-zoca-pink-text/40 bg-zoca-pink-text/10 p-2 text-xs text-zoca-pink-text">
            <strong>Dedup guard removed {h.duplicateEventsRemoved.toLocaleString()} duplicate events.</strong>{" "}
            Any non-zero value here indicates the source data or runtime was duplicating events — the dedup is now suppressing them.
          </div>
        )}
        {((h.excludedEntities ?? 0) > 0 || (h.multiEntityExpansion ?? 0) > 0) && (
          <div className="mt-2 grid gap-2 rounded-zoca-lg border border-zoca-border bg-zoca-bg-3/30 p-3 text-xs sm:grid-cols-2">
            <div>
              <span className="text-zoca-text-soft">Excluded entities (test / orphan):</span>{" "}
              <strong className="text-white">{(h.excludedEntities ?? 0).toLocaleString()}</strong>
            </div>
            <div>
              <span className="text-zoca-text-soft">Extra rows from multi-location expansion:</span>{" "}
              <strong className="text-white">{(h.multiEntityExpansion ?? 0).toLocaleString()}</strong>
            </div>
          </div>
        )}
        {h.matchBreakdown && (h.matchBreakdown.unmatched > 0 || h.matchBreakdown.notInChrone > 0) && (
          <div className="mt-3 grid gap-2 rounded-zoca-lg border border-zoca-border bg-zoca-bg-3/30 p-3 text-xs sm:grid-cols-4">
            <div>
              <span className="text-zoca-text-soft">Matched by customer_id:</span>{" "}
              <strong className="text-white">{h.matchBreakdown.byCustomerId}</strong>
            </div>
            <div>
              <span className="text-zoca-text-soft">Matched by business name:</span>{" "}
              <strong className="text-[#ffb74d]">{h.matchBreakdown.byBizName}</strong>
            </div>
            <div>
              <span className="text-zoca-text-soft">Not in BaseSheet:</span>{" "}
              <strong className="text-zoca-pink-text">{h.matchBreakdown.unmatched}</strong>
            </div>
            <div>
              <span className="text-zoca-text-soft">Matched but not Chrone:</span>{" "}
              <strong className="text-zoca-pink-text">{h.matchBreakdown.notInChrone}</strong>
            </div>
          </div>
        )}
        {h.fetchErrors.length > 0 && (
          <div className="mt-3 rounded-zoca border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-200">
            <strong>Fetch errors:</strong>
            <ul className="ml-4 mt-1 list-disc">{h.fetchErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </div>
        )}
      </Card>

      {/* ---- Tier cards ---- */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TIER_ORDER.map((t, i) => (
          <TierCard
            key={t}
            tier={t}
            count={tc[t] || 0}
            pct={((tc[t] || 0) / total) * 100}
            onClick={() => { setFilters({ ...emptyFilters(), tier: t }); setTab("tiers"); }}
            delay={i * 70}
          />
        ))}
      </div>

      {/* ---- Window-reactive Book Activity strip ---- */}
      {(() => {
        // Recompute on every windowDays change so the filter has visible effect.
        const totals = viewSnap.customers.map((c) => windowMetrics(c.metrics, windowDays).total);
        const ins = viewSnap.customers.map((c) => windowMetrics(c.metrics, windowDays).in);
        const outs = viewSnap.customers.map((c) => windowMetrics(c.metrics, windowDays).out);
        const sumTotal = totals.reduce((a, b) => a + b, 0);
        const sumIn = ins.reduce((a, b) => a + b, 0);
        const sumOut = outs.reduce((a, b) => a + b, 0);
        const withActivity = totals.filter((n) => n > 0).length;
        const sortedTotals = [...totals].sort((a, b) => a - b);
        const median = sortedTotals.length ? sortedTotals[Math.floor(sortedTotals.length / 2)] : 0;
        const mean = totals.length ? sumTotal / totals.length : 0;
        let topCustomer = viewSnap.customers[0];
        let topVolume = 0;
        for (const c of viewSnap.customers) {
          const t = windowMetrics(c.metrics, windowDays).total;
          if (t > topVolume) { topVolume = t; topCustomer = c; }
        }
        return (
          <Card className="zoca-fade-in zoca-gradient-border !p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-display text-base font-bold text-white">
                Book activity · <span className="zoca-gradient-text">last {windowDays} days</span>
              </h3>
              <p className="text-xs text-zoca-text-soft">
                These numbers change with the Window selector. Score-based charts (tier mix, signal counts, AM exposure) intentionally use all 5 windows.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <HealthStat
                label={`Total comms (${windowDays}d)`}
                value={sumTotal.toLocaleString()}
                sub={`${sumIn.toLocaleString()} in · ${sumOut.toLocaleString()} out`}
                hint={`See all customers sorted by ${windowDays}-day comms volume`}
                onClick={() => { setFilters({ ...currentFilters, sort: "comms_window" }); setTab("all"); }}
              />
              <HealthStat
                label="Customers active"
                value={`${withActivity.toLocaleString()} / ${viewSnap.totalActive.toLocaleString()}`}
                sub={`${pctOf(withActivity, viewSnap.totalActive)}% of view`}
                hint={`See only customers with ≥1 comms event in the last ${windowDays} days`}
                onClick={() => { setFilters({ ...currentFilters, activeInWindow: true, sort: "comms_window" }); setTab("all"); }}
              />
              <HealthStat
                label={`Median ${windowDays}d`}
                value={median.toLocaleString()}
                sub="per customer"
                hint={`See full ${windowDays}-day distribution`}
                onClick={() => { setFilters({ ...currentFilters, sort: "comms_window" }); setTab("all"); }}
              />
              <HealthStat
                label={`Mean ${windowDays}d`}
                value={mean.toFixed(1)}
                sub="per customer"
                hint={`See full ${windowDays}-day distribution`}
                onClick={() => { setFilters({ ...currentFilters, sort: "comms_window" }); setTab("all"); }}
              />
              <HealthStat
                label="Response rate"
                value={sumOut > 0 ? (sumIn / sumOut).toFixed(2) : "—"}
                sub="in / out across view"
                hint="See customers sorted by response rate"
                onClick={() => { setFilters({ ...currentFilters, sort: "ratio" }); setTab("all"); }}
              />
              <HealthStat
                label={`Most active (${windowDays}d)`}
                value={topVolume.toLocaleString()}
                sub={(topCustomer?.company || "—").slice(0, 24)}
                hint="Open this customer's drill-down"
                onClick={() => { if (topCustomer) openDetail(topCustomer); }}
              />
            </div>
          </Card>
        );
      })()}

      {/* ---- Risk mix donut + Score distribution ---- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1 zoca-fade-in">
          <SectionTitle>Risk mix</SectionTitle>
          <div className="mx-auto max-w-[220px]" style={{ height: 220 }}>
            <Doughnut
              data={{
                labels: TIER_ORDER,
                datasets: [{
                  data: TIER_ORDER.map((t) => tc[t] || 0),
                  backgroundColor: TIER_ORDER.map((t) => TIER_COLORS[t]),
                  borderColor: "transparent", borderWidth: 0,
                }],
              }}
              options={{
                responsive: true, maintainAspectRatio: false, cutout: "68%",
                plugins: { legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8, padding: 10, font: { size: 11 } } } },
                onClick: (_, elems) => {
                  if (elems[0] != null) {
                    const tier = TIER_ORDER[elems[0].index];
                    setFilters({ ...emptyFilters(), tier });
                    setTab("risk_list");
                  }
                },
              }}
            />
          </div>
        </Card>

        <Card className="lg:col-span-2 zoca-fade-in">
          <SectionTitle>Score distribution</SectionTitle>
          <div style={{ height: 220 }}>
            <Bar
              data={{
                labels: [...SCORE_BUCKET_LABELS],
                datasets: [{
                  data: viewSnap.scoreDistribution,
                  backgroundColor: SCORE_BUCKET_LABELS.map((_, i) => scoreBucketColor(i)),
                  borderRadius: 5,
                }],
              }}
              options={{
                responsive: true, maintainAspectRatio: false,
                plugins: {
                  legend: { display: false },
                  tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} customers` } },
                },
                scales: {
                  y: { beginAtZero: true, grid: { color: "rgba(200,202,254,0.06)" } },
                  x: { grid: { display: false }, ticks: { color: "#c8cafe", font: { size: 10 } } },
                },
                onClick: (_, elems) => {
                  if (elems[0] != null) {
                    const bucketIdx = elems[0].index;
                    setFilters({ ...currentFilters, scoreBucket: bucketIdx });
                    setTab("all");
                  }
                },
                onHover: (event, chartElement) => {
                  const target = event.native?.target as HTMLElement | undefined;
                  if (target) target.style.cursor = chartElement[0] ? "pointer" : "default";
                },
              }}
            />
          </div>
          <p className="mt-2 text-xs text-zoca-text-soft">
            Each bar = number of customers in that score range. Bar color matches the tier. Click any bar to drill into those customers.
          </p>
        </Card>
      </div>

      {/* ---- Signal prevalence + Channel mix ---- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="zoca-fade-in">
          <SectionTitle>Signal prevalence (score ≥ 30)</SectionTitle>
          <div style={{ height: 220 }}>
            <Bar
              data={{
                labels: ["We went silent", "Client went silent", "Response rate dropped", "Volume/channel collapse"],
                datasets: [{
                  data: [sig.we_silent_any, sig.client_silent_any, sig.response_drop_any, sig.volume_collapse_any],
                  backgroundColor: ["#F87171", "#FBBF24", "#60A5FA", "#A78BFA"],
                  borderRadius: 6,
                }],
              }}
              options={{
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                  y: { beginAtZero: true, grid: { color: "rgba(200,202,254,0.06)" } },
                  x: { grid: { display: false } },
                },
                onClick: (_, elems) => {
                  if (elems[0] != null) {
                    const sigKey = (["ws", "cs", "rd", "vc"] as const)[elems[0].index];
                    setFilters({ ...emptyFilters(), signal: sigKey });
                    setTab("risk_list");
                  }
                },
              }}
            />
          </div>
        </Card>

        <Card className="zoca-fade-in">
          <SectionTitle>Channel usage · {channelWindow}-day window</SectionTitle>
          <div style={{ height: 220 }}>
            <Bar
              data={{
                labels: ["chat", "phone", "video", "sms", "email"].map((s) => s.toUpperCase()),
                datasets: [
                  {
                    label: `Last ${channelWindow}d`,
                    data: ["chat", "phone", "video", "sms", "email"].map((c) => (channelWindow === 30 ? viewSnap.channelCounts.d30[c] : viewSnap.channelCounts.d90[c]) || 0),
                    backgroundColor: channelWindow === 30 ? "#7C2D12" : "#7868f4",
                    borderRadius: 6,
                  },
                ],
              }}
              options={{
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: "top" } },
                scales: {
                  y: { beginAtZero: true, grid: { color: "rgba(200,202,254,0.06)" } },
                  x: { grid: { display: false } },
                },
                onClick: (_, elems) => {
                  if (elems[0] != null) {
                    const idx = elems[0].index;
                    const ch = ["chat", "phone", "video", "sms", "email"][idx];
                    setFilters({ ...currentFilters, channel: ch });
                    setTab("all");
                  }
                },
                onHover: (event, chartElement) => {
                  const target = event.native?.target as HTMLElement | undefined;
                  if (target) target.style.cursor = chartElement[0] ? "pointer" : "default";
                },
              }}
            />
          </div>
          <p className="mt-2 text-xs text-zoca-text-soft">
            Channel mix is aggregated at 30d / 90d only. Window {windowDays}d → uses {channelWindow}d aggregate. Click any bar to filter to customers using that channel.
          </p>
        </Card>
      </div>

      {/* ---- AM exposure: tier-stacked horizontal bar ---- */}
      {viewSnap.amTierBreakdown && viewSnap.amTierBreakdown.length > 0 && (
        <Card className="zoca-fade-in">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle>AM exposure · tier mix per account manager</SectionTitle>
            <div className="flex items-center gap-3 text-xs text-zoca-text-muted">
              {TIER_ORDER.map((t) => (
                <span key={t} className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm" style={{ background: TIER_COLORS[t] }} />
                  {t}
                </span>
              ))}
            </div>
          </div>
          <div style={{ height: Math.max(260, viewSnap.amTierBreakdown.length * 26 + 80) }}>
            <Bar
              data={{
                labels: viewSnap.amTierBreakdown.map((r) => r.am),
                datasets: TIER_ORDER.map((t) => ({
                  label: t,
                  data: viewSnap.amTierBreakdown.map((r) => r[t]),
                  backgroundColor: TIER_COLORS[t],
                  borderWidth: 0,
                })),
              }}
              options={{
                indexAxis: "y",
                responsive: true, maintainAspectRatio: false,
                plugins: {
                  legend: { display: false },
                  tooltip: { mode: "index", intersect: false },
                },
                scales: {
                  x: { stacked: true, beginAtZero: true, grid: { color: "rgba(200,202,254,0.06)" } },
                  y: { stacked: true, grid: { display: false }, ticks: { color: "#c8cafe", font: { size: 11 } } },
                },
                onClick: (_, elems) => {
                  if (elems[0] != null) {
                    const rowIdx = elems[0].index;
                    const dsIdx = elems[0].datasetIndex;
                    const am = viewSnap.amTierBreakdown[rowIdx].am;
                    const tier = TIER_ORDER[dsIdx];
                    setFilters({ ...emptyFilters(), am, tier });
                    setTab("risk_list");
                  }
                },
              }}
            />
          </div>
          <p className="mt-2 text-xs text-zoca-text-soft">Click any segment to filter to that AM + tier.</p>
        </Card>
      )}

      {/* ---- Team pulse bubble chart ---- */}
      <Card className="zoca-fade-in">
        <SectionTitle>Team pulse — volume vs response rate · {windowDays}-day window</SectionTitle>
        <p className="mb-2 text-xs text-zoca-text-soft">
          Each bubble = one customer · X = {windowDays}d comms · Y = in / out response rate · size = 90d total · color = tier.
          Bottom-left = disengaged, top-right = healthy two-way. Click any bubble for details.
        </p>
        <div style={{ height: 320 }}>
          <Bubble
            data={{
              datasets: TIER_ORDER.map((t) => ({
                label: t,
                data: viewSnap.customers
                  .filter((c) => c.signals.tier === t)
                  .map((c) => {
                    const w = windowMetrics(c.metrics, windowDays);
                    return {
                      x: w.total,
                      y: w.out > 0 ? w.in / w.out : 0,
                      r: Math.max(3, Math.min(14, 3 + Math.sqrt(c.metrics.total_90d))),
                      _c: c,
                    };
                  })
                  .filter((p) => p.x > 0),
                backgroundColor: TIER_COLORS[t] + "aa",
                borderColor: TIER_COLORS[t],
                borderWidth: 1,
              })),
            }}
            options={{
              responsive: true, maintainAspectRatio: false,
              layout: { padding: 20 },
              plugins: {
                legend: { position: "top", labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } } },
                tooltip: {
                  callbacks: {
                    label: (ctx) => {
                      const d = ctx.raw as { x: number; y: number; r: number; _c: ScoredCustomer };
                      const w = windowMetrics(d._c.metrics, windowDays);
                      return [
                        d._c.company,
                        `${d._c.am_name || "—"} · ${d._c.signals.tier}`,
                        `${windowDays}d: ${w.in} in / ${w.out} out · 90d: ${d._c.metrics.total_90d}`,
                      ];
                    },
                  },
                },
              },
              scales: {
                x: { title: { display: true, text: `${windowDays}-day comms volume`, color: "#c8cafe" }, beginAtZero: true, grid: { color: "rgba(200,202,254,0.06)" } },
                y: { title: { display: true, text: "Response rate (in / out)", color: "#c8cafe" }, beginAtZero: true, suggestedMax: 2, grid: { color: "rgba(200,202,254,0.06)" } },
              },
            }}
          />
        </div>
      </Card>

      <Card className="zoca-fade-in">
        <SectionTitle>Methodology</SectionTitle>
        <div className="grid gap-3 text-sm text-zoca-text-muted md:grid-cols-2">
          <div>
            <p>Scope: live Chargebee subscriptions (<code>active</code>, <code>non_renewing</code>, <code>in_trial</code>) joined to Zoca entities via BaseSheet <code>customer_id → entity_id</code>.</p>
            <p className="mt-2">Channels: App Chat, Email, Phone, Video (Fireflies), SMS — from the 5 Metabase public CSVs. Windows: 7 / 14 / 30 / 60 / 90 days rolling from last cron run.</p>
          </div>
          <div>
            <p>Signals (each 0–100): We-Silent, Client-Silent, Response-Drop, Volume/Channel-Collapse. Composite = 30%·WeSilent + 30%·ClientSilent + 25%·ResponseDrop + 15%·VolumeCollapse.</p>
            <p className="mt-2">Tier cuts: HIGH ≥ 65 (or zero comms in 90d), MEDIUM 35–64, LOW 15–34, HEALTHY &lt; 15. Hit <strong>Refresh</strong> at the top of the page any time for fresh data.</p>
          </div>
        </div>
        {snap.errors && snap.errors.length > 0 && (
          <div className="mt-3 rounded-zoca border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
            Last refresh had errors:
            <ul className="ml-4 list-disc">{snap.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </div>
        )}
      </Card>
    </div>
  );
}

function TiersView({
  viewSnap, setFilters, setTab,
}: {
  viewSnap: ViewSnap | null; setFilters: (f: Filters) => void; setTab: (k: TabKey) => void;
}) {
  if (!viewSnap) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {TIER_ORDER.map((t) => {
        const count = viewSnap.tierCounts[t] || 0;
        const sample = viewSnap.customers.filter((c) => c.signals.tier === t).slice(0, 5);
        return (
          <Card key={t} className="zoca-fade-in">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ background: TIER_COLORS[t] }} />
                <h3 className="font-display text-lg font-bold text-white">{t}</h3>
                <span className="text-sm text-zoca-text-muted">{count} customers</span>
              </div>
              <button
                className="zoca-btn zoca-btn-ghost"
                onClick={() => { setFilters({ ...emptyFilters(), tier: t }); setTab("risk_list"); }}
              >
                View all →
              </button>
            </div>
            <div className="divide-y divide-zoca-border text-sm">
              {sample.length === 0 && <div className="py-3 text-zoca-text-soft">No customers in this tier.</div>}
              {sample.map((c) => (
                <div key={c.customer_id} className="flex items-center justify-between py-2">
                  <div className="truncate">
                    <div className="truncate font-medium text-white">{c.company || "(no name)"}</div>
                    <div className="text-xs text-zoca-text-soft">{c.am_name || "—"}</div>
                  </div>
                  <div className="num text-sm font-semibold" style={{ color: scoreColor(c.signals.score) }}>
                    {c.signals.score}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function SignalsView({
  viewSnap, setFilters, setTab,
}: {
  viewSnap: ViewSnap | null; setFilters: (f: Filters) => void; setTab: (k: TabKey) => void;
}) {
  if (!viewSnap) return null;
  const entries: { key: Filters["signal"]; label: string; count: number; field: keyof ScoredCustomer["signals"] }[] = [
    { key: "ws", label: "We went silent", count: viewSnap.signalCounts.we_silent_any, field: "sig_we_silent" },
    { key: "cs", label: "Client went silent", count: viewSnap.signalCounts.client_silent_any, field: "sig_client_silent" },
    { key: "rd", label: "Response rate dropped", count: viewSnap.signalCounts.response_drop_any, field: "sig_response_drop" },
    { key: "vc", label: "Volume/channel collapse", count: viewSnap.signalCounts.volume_collapse_any, field: "sig_volume_collapse" },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {entries.map((e) => {
        const top = [...viewSnap.customers]
          .filter((c) => Number(c.signals[e.field as keyof ScoredCustomer["signals"]]) >= 70)
          .slice(0, 6);
        return (
          <Card key={e.label} className="zoca-fade-in">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="font-display text-lg font-bold text-white">{e.label}</h3>
                <p className="text-xs text-zoca-text-soft">
                  {e.count} customers ({((e.count / Math.max(1, viewSnap.totalActive)) * 100).toFixed(1)}% of view) with score ≥ 30
                </p>
              </div>
              <button
                className="zoca-btn zoca-btn-ghost"
                onClick={() => { setFilters({ ...emptyFilters(), signal: e.key }); setTab("risk_list"); }}
              >
                See list →
              </button>
            </div>
            <div className="divide-y divide-zoca-border text-sm">
              {top.length === 0 && <div className="py-3 text-zoca-text-soft">No strong matches yet.</div>}
              {top.map((c) => (
                <div key={c.customer_id} className="flex items-center justify-between py-2">
                  <div className="truncate">
                    <div className="truncate font-medium text-white">{c.company || "(no name)"}</div>
                    <div className="truncate text-xs text-zoca-text-soft">{c.signals.notes}</div>
                  </div>
                  <div className="num text-sm font-semibold" style={{ color: scoreColor(c.signals.score) }}>
                    {c.signals.score}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function AmExposureView({
  viewSnap, setFilters, setTab,
}: {
  viewSnap: ViewSnap | null; setFilters: (f: Filters) => void; setTab: (k: TabKey) => void;
}) {
  if (!viewSnap) return null;
  const sorted = [...viewSnap.amExposure].sort((a, b) => (b.high - a.high) || (b.total - a.total));
  return (
    <Card className="zoca-fade-in">
      <SectionTitle>AM exposure across the book</SectionTitle>
      <div className="overflow-auto scroll-thin">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-zoca-bg-2/95">
            <tr>
              <Th>AM</Th>
              <Th num>HIGH</Th>
              <Th num>Book size</Th>
              <Th num>% HIGH</Th>
              <Th num>Concentration</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ am, high, total }) => {
              const pct = total ? (high / total) * 100 : 0;
              return (
                <tr
                  key={am}
                  className="cursor-pointer border-t border-zoca-border hover:bg-zoca-bg-3/40"
                  onClick={() => { setFilters({ ...emptyFilters(), am, tier: "HIGH" }); setTab("risk_list"); }}
                >
                  <Td>{am}</Td>
                  <Td num><span className="text-zoca-pink-text">{high}</span></Td>
                  <Td num>{total}</Td>
                  <Td num>{pct.toFixed(0)}%</Td>
                  <Td>
                    <div className="h-2 w-48 rounded-full bg-zoca-bg-3/60">
                      <div className="h-2 rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: "#7C2D12" }} />
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RiskList({
  customers, windowDays, openDetail,
}: { customers: ScoredCustomer[]; windowDays: WindowDays; openDetail: (c: ScoredCustomer) => void }) {
  if (!customers.length) {
    return (
      <Card className="zoca-fade-in">
        <p className="text-zoca-text-muted">No customers match these filters.</p>
      </Card>
    );
  }
  return (
    <Card className="zoca-fade-in">
      <SectionTitle>{customers.length.toLocaleString()} customers</SectionTitle>
      <div className="max-h-[620px] overflow-auto scroll-thin">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-zoca-bg-2/95">
            <tr>
              <Th>Customer</Th>
              <Th>AM</Th>
              <Th num>Score</Th>
              <Th>Tier</Th>
              <Th num>Days since we touched</Th>
              <Th num>Days since client touched</Th>
              <Th num>{windowDays}d</Th>
              <Th num>90d</Th>
              <Th>Signals</Th>
              <Th>Why</Th>
            </tr>
          </thead>
          <tbody>
            {customers.slice(0, 500).map((c) => {
              const sigs: string[] = [];
              if (c.signals.sig_we_silent >= 30) sigs.push("We");
              if (c.signals.sig_client_silent >= 30) sigs.push("Client");
              if (c.signals.sig_response_drop >= 30) sigs.push("Drop");
              if (c.signals.sig_volume_collapse >= 30) sigs.push("Vol");
              const w = windowMetrics(c.metrics, windowDays);
              return (
                <tr
                  key={`${c.customer_id}::${c.entity_id}`}
                  className="cursor-pointer border-t border-zoca-border hover:bg-zoca-bg-3/40"
                  onClick={() => openDetail(c)}
                >
                  <Td>
                    <div className="font-semibold text-white">{c.company || "(no name)"}</div>
                    <div className="text-xs text-zoca-text-soft">{c.cb_status} · {c.zoca_status || "—"}</div>
                  </Td>
                  <Td>{c.am_name || "—"}</Td>
                  <Td num>
                    <span
                      className="num inline-block min-w-[30px] rounded-md px-2 py-0.5 text-xs font-semibold text-white"
                      style={{ background: scoreColor(c.signals.score) }}
                    >
                      {c.signals.score}
                    </span>
                  </Td>
                  <Td><TierChip tier={c.signals.tier} /></Td>
                  <Td num>{fmtDaysSince(c.metrics.days_since_out)}</Td>
                  <Td num>{fmtDaysSince(c.metrics.days_since_in)}</Td>
                  <Td num>{w.total}</Td>
                  <Td num>{c.metrics.total_90d}</Td>
                  <Td>
                    <div className="flex gap-1">
                      {sigs.map((s) => <span key={s} className="rounded-full bg-zoca-purple/20 px-1.5 py-0.5 text-[10px] text-zoca-light-lavender">{s}</span>)}
                    </div>
                  </Td>
                  <Td className="max-w-[320px] truncate text-xs text-zoca-text-soft">{c.signals.notes}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {customers.length > 500 && (
          <div className="mt-2 text-center text-xs text-zoca-text-soft">Showing first 500 of {customers.length}. Narrow filters to see more.</div>
        )}
      </div>
    </Card>
  );
}

/* ================================================================= modal */

function CustomerModal({ customer, onClose }: { customer: ScoredCustomer; onClose: () => void }) {
  const m = customer.metrics;
  const s = customer.signals;
  const trendData = {
    labels: ["90→60d", "60→30d", "30→14d", "14→7d", "7d"],
    datasets: [{
      data: [
        m.total_90d - m.total_60d,
        m.total_60d - m.total_30d,
        m.total_30d - m.total_14d,
        m.total_14d - m.total_7d,
        m.total_7d,
      ],
      borderColor: scoreColor(s.score),
      backgroundColor: scoreColor(s.score) + "33",
      tension: 0.3,
      fill: true,
      pointRadius: 3,
    }],
  };
  return (
    <div className="modal-overlay fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="modal-panel max-h-[90vh] w-full max-w-2xl overflow-auto scroll-thin rounded-zoca-2xl border border-zoca-border-2 bg-zoca-bg-2 p-6 shadow-zoca-lg backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-2xl font-black text-white">{customer.company || "(no name)"}</h2>
            <p className="text-sm text-zoca-text-muted">
              <span className="text-zoca-text-soft">AM:</span> {customer.am_name || "—"}
              {customer.email && (<> · <span className="text-zoca-text-soft">{customer.email}</span></>)}
            </p>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-zoca-text-muted hover:bg-zoca-bg-3 hover:text-white">✕</button>
        </div>

        <div className="mt-4 rounded-zoca-xl border border-zoca-border-2 bg-zoca-bg-3/60 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-zoca-text-soft">Composite</div>
          <div className="flex items-end gap-3">
            <div className="num num-hero font-display text-4xl font-black" style={{ color: scoreColor(s.score) }}>
              {s.score}
            </div>
            <TierChip tier={s.tier} />
          </div>
          {s.notes && <p className="mt-2 text-sm text-zoca-text-muted">{s.notes}</p>}
        </div>

        <h3 className="mt-5 mb-2 text-sm font-semibold text-zoca-light-lavender">Signals</h3>
        <div className="space-y-1.5">
          <SigBar name="We went silent" value={s.sig_we_silent} />
          <SigBar name="Client went silent" value={s.sig_client_silent} />
          <SigBar name="Response rate drop" value={s.sig_response_drop} />
          <SigBar name="Volume/channel drop" value={s.sig_volume_collapse} />
        </div>

        <h3 className="mt-5 mb-2 text-sm font-semibold text-zoca-light-lavender">Comms trend</h3>
        <div style={{ height: 160 }}>
          <Line
            data={trendData}
            options={{
              responsive: true, maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                y: { beginAtZero: true, grid: { color: "rgba(200,202,254,0.06)" } },
                x: { grid: { display: false } },
              },
            }}
          />
        </div>

        <h3 className="mt-5 mb-2 text-sm font-semibold text-zoca-light-lavender">Window breakdown</h3>
        <div className="overflow-auto scroll-thin">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <Th>Window</Th><Th num>In</Th><Th num>Out</Th><Th num>Total</Th><Th num>Channels</Th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-zoca-border">
                <Td>7d</Td><Td num>{m.in_7d}</Td><Td num>{m.out_7d}</Td><Td num>{m.total_7d}</Td><Td num>{m.channels_7d}</Td>
              </tr>
              <tr className="border-t border-zoca-border">
                <Td>14d</Td><Td num>{m.in_14d}</Td><Td num>{m.out_14d}</Td><Td num>{m.total_14d}</Td><Td num>{m.channels_14d}</Td>
              </tr>
              <tr className="border-t border-zoca-border">
                <Td>30d</Td><Td num>{m.in_30d}</Td><Td num>{m.out_30d}</Td><Td num>{m.total_30d}</Td><Td num>{m.channels_30d}</Td>
              </tr>
              <tr className="border-t border-zoca-border">
                <Td>60d</Td><Td num>{m.in_60d}</Td><Td num>{m.out_60d}</Td><Td num>{m.total_60d}</Td><Td num>{m.channels_60d}</Td>
              </tr>
              <tr className="border-t border-zoca-border">
                <Td>90d</Td><Td num>{m.in_90d}</Td><Td num>{m.out_90d}</Td><Td num>{m.total_90d}</Td><Td num>{m.channels_90d}</Td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="mt-5 mb-2 text-sm font-semibold text-zoca-light-lavender">Channels used</h3>
        <div className="flex flex-wrap gap-2 text-xs">
          {(m.channels_used_90d || "").split(",").filter(Boolean).map((c) => (
            <span
              key={c}
              className="rounded-full px-2 py-0.5"
              style={{ background: (CHANNEL_COLORS[c] || "#7868f4") + "22", color: CHANNEL_COLORS[c] || "#c8cafe" }}
            >
              {c}
            </span>
          ))}
          {!m.channels_used_90d && <span className="text-zoca-text-soft">No comms on file.</span>}
        </div>

        <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
          <dt className="text-zoca-text-soft">Chargebee status</dt>
          <dd className="text-white">{customer.cb_status}{customer.auto_collection ? ` · auto-collection: ${customer.auto_collection}` : ""}</dd>
          <dt className="text-zoca-text-soft">Zoca status</dt>
          <dd className="text-white">{customer.zoca_status || "—"}</dd>
          <dt className="text-zoca-text-soft">MRR (BaseSheet)</dt>
          <dd className="text-white">{customer.mrr_basesheet || "—"}</dd>
          <dt className="text-zoca-text-soft">Plan amount</dt>
          <dd className="text-white">${customer.plan_amount.toFixed(2)}</dd>
          <dt className="text-zoca-text-soft">Customer ID</dt>
          <dd className="text-white">{customer.customer_id}</dd>
          <dt className="text-zoca-text-soft">Entity ID</dt>
          <dd className="text-white">{customer.entity_id || "—"}</dd>
        </dl>
      </div>
    </div>
  );
}

function SigBar({ name, value }: { name: string; value: number }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-[140px] text-xs text-zoca-text-muted">{name}</div>
      <div className="h-2 flex-1 rounded-full bg-zoca-bg-3/60">
        <div
          className="h-2 rounded-full"
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            background: value >= 65 ? "#7C2D12" : value >= 35 ? "#ffb74d" : "#7868f4",
          }}
        />
      </div>
      <div className="num w-10 text-right text-xs font-semibold text-white">{value}</div>
    </div>
  );
}

/* =========================================================== UI primitives */

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cls(
      "rounded-zoca-2xl border border-zoca-border-2 bg-zoca-card p-6 shadow-zoca-md backdrop-blur-xl transition-colors hover:border-zoca-border-3",
      className,
    )}>
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-4 font-display text-base font-bold tracking-zoca-tight text-white">{children}</h3>
  );
}

function HealthStat({
  label, value, sub, ok, onClick, hint,
}: { label: string; value: string; sub?: string; ok?: boolean; onClick?: () => void; hint?: string }) {
  const valueColor = ok === true ? "text-[#76FF03]" : ok === false ? "text-zoca-pink-text" : "text-white";
  const clickable = !!onClick;
  const Tag: "button" | "div" = clickable ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      title={clickable ? hint || "Click to drill in" : undefined}
      className={cls(
        "group block w-full text-left rounded-zoca-lg border border-zoca-border bg-zoca-bg-3/40 p-3 transition",
        clickable && "cursor-pointer hover:border-zoca-pink-1/40 hover:bg-zoca-bg-3/70 hover:shadow-zoca-glow",
      )}
    >
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.1em] text-zoca-text-soft">
        <span>{label}</span>
        {clickable && <span className="text-zoca-text-soft transition group-hover:translate-x-0.5 group-hover:text-zoca-pink-2">→</span>}
      </div>
      <div className={`num mt-1 font-display text-base font-semibold leading-tight ${valueColor}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-zoca-text-muted">{sub}</div>}
    </Tag>
  );
}

function Th({ children, num = false }: { children: React.ReactNode; num?: boolean }) {
  return (
    <th className={cls(
      num ? "text-right" : "text-left",
      "whitespace-nowrap px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-zoca-text-soft",
    )}>
      {children}
    </th>
  );
}

function Td({ children, num = false, className = "" }: { children: React.ReactNode; num?: boolean; className?: string }) {
  return (
    <td className={cls(
      num ? "num text-right" : "",
      "whitespace-nowrap px-3 py-2.5 text-zoca-text-primary",
      className,
    )}>
      {children}
    </td>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-zoca-pill border border-zoca-purple/30 bg-zoca-purple/15 px-3 py-1 text-xs font-medium text-zoca-light-lavender">
      {label}
      <button
        onClick={onClear}
        className="ml-0.5 rounded-full bg-zoca-bg-2/70 px-1.5 py-0.5 leading-none text-[10px] text-zoca-text-muted hover:bg-zoca-bg-3 hover:text-white"
        aria-label="Clear filter"
      >
        ✕
      </button>
    </span>
  );
}

function TierChip({ tier }: { tier: Tier }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold"
      style={{ background: TIER_COLORS[tier] + "22", color: TIER_COLORS[tier] }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: TIER_COLORS[tier] }} />
      {tier}
    </span>
  );
}

function TierCard({
  tier, count, pct, onClick, delay,
}: { tier: Tier; count: number; pct: number; onClick: () => void; delay: number }) {
  const color = TIER_COLORS[tier];
  return (
    <button
      onClick={onClick}
      style={{ ["--fade-delay" as string]: `${delay}ms` } as React.CSSProperties}
      className="group relative w-full overflow-hidden rounded-zoca-xl border border-zoca-border-2 bg-zoca-bg-2/55 p-5 text-left backdrop-blur-sm zoca-fade-in zoca-glow-hover"
    >
      <div
        className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-35 blur-2xl transition-opacity group-hover:opacity-60"
        style={{ background: color }}
      />
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zoca-text-soft">{tier}</span>
      </div>
      <div className="num num-hero mt-1.5 font-display text-[2.25rem] font-black leading-none tracking-zoca-tight text-white">
        {count}
      </div>
      <div className="mt-1.5 text-xs text-zoca-text-muted">{pct.toFixed(1)}% of book</div>
    </button>
  );
}

/* ============================================================ load states */

function LoadingPane() {
  return (
    <div className="rounded-zoca-2xl border border-zoca-border-2 bg-zoca-card p-10 text-center shadow-zoca-md">
      <div className="mx-auto mb-3 h-6 w-6 rounded-full border-2 border-zoca-pink-1 border-t-transparent refresh-spinning" />
      <p className="text-sm text-zoca-text-muted">Loading latest snapshot…</p>
      <p className="mt-1 text-xs text-zoca-text-soft">
        If this is the first deploy and nothing's been scored yet, hit <code>/api/snapshot?rebuild=1</code> once.
      </p>
    </div>
  );
}

function ErrorPane({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="rounded-zoca-2xl border border-red-500/40 bg-red-500/10 p-6 text-center shadow-zoca-md">
      <p className="text-sm font-semibold text-red-200">Could not load snapshot</p>
      <p className="mt-1 break-words text-xs text-red-200/80">{error}</p>
      <button className="zoca-btn mt-3" onClick={onRetry}>Retry (with rebuild)</button>
    </div>
  );
}
