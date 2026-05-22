"use client";
// Phase 33.brand-watchfire-T11 — page ambient (sign-in lockup at viewport center).
import { BeaconAmbient } from "./BeaconAmbient";
// Phase 33.brand-watchfire-pink-sweep-v2 (5 hex/rgba + 0 tailwind-rose swept)

import React, { useCallback, useEffect, useMemo, useState } from "react";
import V2Header from "./V2Header";
import V2ManagerHero from "./V2ManagerHero";
import { ZocaLogo } from "./ZocaLogo";
import type { SnapshotV2, ScoredCustomerV2 } from "@/lib/customer/types";
import { POD_MAP } from "@/lib/customer/config";
import V2PodSummaryGrid from "./V2PodSummaryGrid";
import V2SignalHeatmap from "./V2SignalHeatmap";
import V2Rollup from "./V2Rollup";
import V2ManagerToolbar, { type SavedView, nearestAvailable } from "./V2ManagerToolbar";
import V2StoplightMovement from "./V2StoplightMovement";
import V2Sparkline from "./V2Sparkline";
import ScopeStrip from "./ScopeStrip";
import FreshnessBanner from "./FreshnessBanner";
import V2AmActivityRollup from "./V2AmActivityRollup";
import V2CoachingLoops from "./V2CoachingLoops";
import type { CoachingRow, CoachingMetric } from "@/lib/customer/coaching";
import { AnimatedNumber } from "./AnimatedNumber";
import { AmLink } from "./AmLink";
import { ToastProvider } from "./Toast";
import { AmStoplightStack, type AmStoplightRow } from "./charts/AmStoplightStack";
import { OutcomeBreakdownDonut } from "./charts/OutcomeBreakdownDonut";
import { TopSignalsBar } from "./charts/TopSignalsBar";

const STORAGE_POD_KEY = "zoca_v2_manager_pod";
const STORAGE_VIEWS_KEY = "zoca_v2_manager_views";
const STORAGE_DELETED_DEFAULTS_KEY = "zoca_v2_manager_deleted_defaults";
const STORAGE_CURRENT_DATE_KEY = "zoca_v2_manager_date";
const STORAGE_COMPARE_KEY = "zoca_v2_manager_compare";

type TierTrendRow = {
  snapshot_date: string;
  total_customers: number;
  total_high_risk: number;
  total_watch: number;
  total_medium: number;
  total_low: number;
  total_healthy: number;
};

type AmTrendPoint = {
  date: string;
  total: number;
  red: number;
  yellow: number;
  green: number;
  mrr: number;
  mrr_at_risk: number;
};

type PodTrendPoint = {
  date: string;
  red: number;
  yellow: number;
  green: number;
  total: number;
};

type SnapshotState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: SnapshotV2 };

const POD_COLOR_DOT: Record<string, string> = {
  "Pod 1": "bg-violet-500",
  "Pod 2": "bg-cyan-500",
  "Pod 3": "bg-emerald-500",
  "Pod 4": "bg-amber-500",
  "Pod 5": "bg-pink-500",
  Floating: "bg-slate-500",
};

const DEFAULT_VIEWS: SavedView[] = [
  { name: "Today, all pods", selectedPod: "All", currentDate: "today", compareDays: 0 },
  { name: "Today, Pod 4", selectedPod: "Pod 4", currentDate: "today", compareDays: 0 },
  { name: "Week-over-week", selectedPod: "All", currentDate: "today", compareDays: 7 },
];

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `$${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return n > 0 ? `$${Math.round(n).toLocaleString()}` : "$0";
}

function formatSnapshotDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function loadStoredViews(): SavedView[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_VIEWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is SavedView =>
        v &&
        typeof v.name === "string" &&
        typeof v.selectedPod === "string" &&
        typeof v.currentDate === "string" &&
        typeof v.compareDays === "number",
    );
  } catch {
    return [];
  }
}

function loadDeletedDefaults(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_DELETED_DEFAULTS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((n) => typeof n === "string"));
  } catch {
    /* fall through */
  }
  return new Set();
}

function persistViews(views: SavedView[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_VIEWS_KEY, JSON.stringify(views));
  } catch {
    /* ignore */
  }
}

function persistDeletedDefaults(deleted: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_DELETED_DEFAULTS_KEY,
      JSON.stringify(Array.from(deleted)),
    );
  } catch {
    /* ignore */
  }
}

async function fetchSnapshotByDate(date: string): Promise<SnapshotV2> {
  const url = date === "today" ? "/api/v2/snapshot" : `/api/v2/snapshot/by-date/${date}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${msg.slice(0, 200)}`);
  }
  return (await res.json()) as SnapshotV2;
}

function dateNDaysAgo(refIso: string, days: number): string {
  const d = new Date(refIso);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isValidDate(s: string): boolean {
  return s === "today" || /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function V2ManagerDashboardInner() {
  const [snapshot, setSnapshot] = useState<SnapshotState>({ status: "loading" });
  const [compareSnapshot, setCompareSnapshot] = useState<SnapshotV2 | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedPod, setSelectedPod] = useState<string>("All");
  const [currentDate, setCurrentDate] = useState<string>("today");
  const [compareDays, setCompareDays] = useState<number>(0);
  const [storedViews, setStoredViews] = useState<SavedView[]>([]);
  const [deletedDefaults, setDeletedDefaults] = useState<Set<string>>(new Set());
  const [currentViewName, setCurrentViewName] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [tierTrend, setTierTrend] = useState<TierTrendRow[]>([]);
  const [amTrends, setAmTrends] = useState<Record<string, AmTrendPoint[]>>({});
  const [podTrends, setPodTrends] = useState<Record<string, PodTrendPoint[]>>({});
  const [moverMode, setMoverMode] = useState<"red" | "trajectory">("red");
  // Phase 27 — coaching loops state
  const [coachingRows, setCoachingRows] = useState<CoachingRow[]>([]);
  const [coachingFilter, setCoachingFilter] = useState<
    { amName: string; metric: CoachingMetric } | null
  >(null);

  // Hydrate: URL params override localStorage
  useEffect(() => {
    setMounted(true);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const qDate = url.searchParams.get("date");
    const qCompare = url.searchParams.get("compare");
    const qPod = url.searchParams.get("pod");

    const pod =
      qPod ?? window.localStorage.getItem(STORAGE_POD_KEY) ?? "All";
    const date =
      (qDate && isValidDate(qDate) ? qDate : null) ??
      window.localStorage.getItem(STORAGE_CURRENT_DATE_KEY) ??
      "today";
    const cmpRaw =
      qCompare ?? window.localStorage.getItem(STORAGE_COMPARE_KEY) ?? "0";
    const cmp = Number(cmpRaw) || 0;

    setSelectedPod(pod);
    setCurrentDate(date);
    setCompareDays(cmp);
    setStoredViews(loadStoredViews());
    setDeletedDefaults(loadDeletedDefaults());
  }, []);

  // Merge stored + defaults (excluding user-deleted defaults)
  const savedViews = useMemo<SavedView[]>(() => {
    const storedNames = new Set(storedViews.map((v) => v.name));
    const defaultsToShow = DEFAULT_VIEWS.filter(
      (d) => !deletedDefaults.has(d.name) && !storedNames.has(d.name),
    );
    return [...storedViews, ...defaultsToShow];
  }, [storedViews, deletedDefaults]);

  // Persist localStorage + push URL params
  useEffect(() => {
    if (!mounted || typeof window === "undefined") return;
    if (selectedPod === "All") window.localStorage.removeItem(STORAGE_POD_KEY);
    else window.localStorage.setItem(STORAGE_POD_KEY, selectedPod);
    const url = new URL(window.location.href);
    if (selectedPod === "All") url.searchParams.delete("pod");
    else url.searchParams.set("pod", selectedPod);
    window.history.replaceState({}, "", url.toString());
  }, [selectedPod, mounted]);

  useEffect(() => {
    if (!mounted || typeof window === "undefined") return;
    if (currentDate === "today") window.localStorage.removeItem(STORAGE_CURRENT_DATE_KEY);
    else window.localStorage.setItem(STORAGE_CURRENT_DATE_KEY, currentDate);
    const url = new URL(window.location.href);
    if (currentDate === "today") url.searchParams.delete("date");
    else url.searchParams.set("date", currentDate);
    window.history.replaceState({}, "", url.toString());
  }, [currentDate, mounted]);

  useEffect(() => {
    if (!mounted || typeof window === "undefined") return;
    if (compareDays === 0) window.localStorage.removeItem(STORAGE_COMPARE_KEY);
    else window.localStorage.setItem(STORAGE_COMPARE_KEY, String(compareDays));
    const url = new URL(window.location.href);
    if (compareDays === 0) url.searchParams.delete("compare");
    else url.searchParams.set("compare", String(compareDays));
    window.history.replaceState({}, "", url.toString());
  }, [compareDays, mounted]);

  // Parallel-fetch the three independent secondary feeds (dates / tier-trend / pod-trends)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [datesRes, trendRes, podRes] = await Promise.allSettled([
        fetch("/api/v2/snapshot/dates?limit=30", { cache: "no-store" }),
        fetch("/api/v2/snapshot/trend?days=14", { cache: "no-store" }),
        fetch("/api/v2/trends/pods?days=14", { cache: "no-store" }),
      ]);
      if (cancelled) return;
      try {
        if (datesRes.status === "fulfilled" && datesRes.value.ok) {
          const json = (await datesRes.value.json()) as { dates: string[] };
          if (!cancelled) setAvailableDates(json.dates || []);
        }
      } catch { /* ignore */ }
      try {
        if (trendRes.status === "fulfilled" && trendRes.value.ok) {
          const json = (await trendRes.value.json()) as { rows: TierTrendRow[] };
          if (!cancelled) setTierTrend(json.rows || []);
        }
      } catch { /* ignore */ }
      try {
        if (podRes.status === "fulfilled" && podRes.value.ok) {
          const json = (await podRes.value.json()) as {
            data: { pod: string; points: PodTrendPoint[] }[];
          };
          const map: Record<string, PodTrendPoint[]> = {};
          for (const b of json.data || []) map[b.pod] = b.points;
          if (!cancelled) setPodTrends(map);
        }
      } catch { /* ignore */ }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch primary snapshot
  useEffect(() => {
    let cancelled = false;
    setSnapshot({ status: "loading" });
    (async () => {
      try {
        const snap = await fetchSnapshotByDate(currentDate);
        if (!cancelled) setSnapshot({ status: "ready", snapshot: snap });
      } catch (e) {
        if (!cancelled) {
          setSnapshot({
            status: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentDate]);

  // Fetch comparison snapshot
  useEffect(() => {
    if (compareDays === 0 || snapshot.status !== "ready") {
      setCompareSnapshot(null);
      setCompareError(null);
      setComparisonLoading(false);
      return;
    }
    let cancelled = false;
    const refIso = snapshot.snapshot.generatedAt;
    const target = dateNDaysAgo(refIso, compareDays);
    setComparisonLoading(true);
    (async () => {
      try {
        const snap = await fetchSnapshotByDate(target);
        if (!cancelled) {
          setCompareSnapshot(snap);
          setCompareError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setCompareSnapshot(null);
          // Suggest nearest available date if 404
          const message = e instanceof Error ? e.message : String(e);
          const nearest =
            message.includes("404") || message.includes("no snapshot")
              ? nearestAvailable(target, availableDates)
              : null;
          setCompareError(
            nearest ? `No snapshot for ${target}. Nearest available: ${nearest}.` : message,
          );
        }
      } finally {
        if (!cancelled) setComparisonLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compareDays, snapshot, availableDates]);

  // Phase 27 — fetch coaching rows whenever the primary snapshot is ready.
  // The /api/v2/coaching route reads its own latest snapshot server-side, so
  // we just trigger a refetch when the displayed snapshot changes.
  useEffect(() => {
    if (snapshot.status !== "ready") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/v2/coaching", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { ok: boolean; rows: CoachingRow[] };
        if (cancelled) return;
        setCoachingRows(json.ok ? json.rows || [] : []);
      } catch {
        /* ignore — UI shows empty state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot]);

  const refIso = snapshot.status === "ready" ? snapshot.snapshot.generatedAt : null;

  const kpis = useMemo(() => {
    if (snapshot.status !== "ready") return null;
    let total = 0;
    let RED = 0;
    let YELLOW = 0;
    let GREEN = 0;
    // Phase 33.H.1 — 4-tier health_tier counts (MONITOR fallback for missing metabase_health)
    let critical = 0;
    let atRisk = 0;
    let monitor = 0;
    let healthy = 0;
    let mrr = 0;
    let mrrAtRisk = 0;
    const actionAmsSet = new Set<string>();
    const podSet = new Set<string>();
    let flagged = 0;
    let preLaunch = 0;
    for (const c of snapshot.snapshot.customers) {
      // Phase 33.scope followup — exclude recently_churned from main kpis tally.
      // They already surface in ScopeStrip via the +N recently churned suffix.
      if ((c as any).lifecycle_state === "recently_churned") continue;
      total += 1;
      const sl = c.signals_v2.stoplight;
      if (sl === "RED") RED += 1;
      else if (sl === "YELLOW") YELLOW += 1;
      else GREEN += 1;
      // Phase 33.H.1 — read metabase_health tier; missing/null falls back to MONITOR
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
      mrr += c.plan_amount || 0;
      // Phase 33.H.1 — MRR-at-risk now uses Critical+At-risk (the "needs call" semantic)
      if (_ht === "CRITICAL" || _ht === "AT-RISK") {
        mrrAtRisk += c.plan_amount || 0;
        if (c.am_name) actionAmsSet.add(c.am_name);
      }
      const pod = POD_MAP[c.am_name] || "Floating";
      podSet.add(pod);
      if (c.performance?.flag) flagged += 1;
      if (c.signals_v2.pre_launch) preLaunch += 1;
    }
    const needsCall = critical + atRisk;
    return {
      total,
      RED,
      YELLOW,
      GREEN,
      critical,
      atRisk,
      monitor,
      healthy,
      needsCall,
      mrr,
      mrrAtRisk,
      pctRed: total ? (RED / total) * 100 : 0,
      pctNeedsCall: total ? (needsCall / total) * 100 : 0,
      pctCritical: total ? (critical / total) * 100 : 0,
      pctAtRisk: total ? (atRisk / total) * 100 : 0,
      amsWithAction: actionAmsSet.size,
      podsRepresented: podSet.size,
      flagged,
      preLaunch,
    };
  }, [snapshot]);

  const compareKpis = useMemo(() => {
    if (!compareSnapshot) return null;
    let total = 0;
    let RED = 0;
    let YELLOW = 0;
    let GREEN = 0;
    let critical = 0;
    let atRisk = 0;
    let monitor = 0;
    let healthy = 0;
    let mrrAtRisk = 0;
    const actionAmsSet = new Set<string>();
    for (const c of compareSnapshot.customers) {
      // Phase 33.scope optionB manager compareKpis exclude recently_churned
      if (c.lifecycle_state === "recently_churned") continue;
      total += 1;
      const sl = c.signals_v2.stoplight;
      if (sl === "RED") RED += 1;
      else if (sl === "YELLOW") YELLOW += 1;
      else GREEN += 1;
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
      if (_ht === "CRITICAL" || _ht === "AT-RISK") {
        mrrAtRisk += c.plan_amount || 0;
        if (c.am_name) actionAmsSet.add(c.am_name);
      }
    }
    const needsCall = critical + atRisk;
    return { total, RED, YELLOW, GREEN, critical, atRisk, monitor, healthy, needsCall, mrrAtRisk, amsWithAction: actionAmsSet.size };
  }, [compareSnapshot]);

  // Phase 33.H.1 — track both legacy red and new needsCall counts per AM for deltas
  const compareCountsByAm = useMemo(() => {
    if (!compareSnapshot) return new Map<string, { red: number; needsCall: number }>();
    const m = new Map<string, { red: number; needsCall: number }>();
    for (const c of compareSnapshot.customers) {
      // Phase 33.scope followup — exclude recently_churned from compareCountsByAm.
      // compareRedByAm reads off this map, so without this, the "RED Δ" arrows
      // on the per-AM rollup compare against a churn-contaminated baseline.
      if ((c as any).lifecycle_state === "recently_churned") continue;
      if (!c.am_name) continue;
      const entry = m.get(c.am_name) || { red: 0, needsCall: 0 };
      if (c.signals_v2.stoplight === "RED") entry.red += 1;
      const _htRaw = ((c as any).metabase_health?.health_tier as string | null | undefined) || "";
      const _ht =
        _htRaw === "CRITICAL - DEAL BREAKER" || _htRaw === "CRITICAL" ? "CRITICAL"
        : _htRaw === "AT-RISK" ? "AT-RISK"
        : _htRaw === "HEALTHY" ? "HEALTHY"
        : "MONITOR";
      if (_ht === "CRITICAL" || _ht === "AT-RISK") entry.needsCall += 1;
      m.set(c.am_name, entry);
    }
    return m;
  }, [compareSnapshot]);
  // Legacy alias retained so any downstream readers keep working
  const compareRedByAm = useMemo(() => {
    const m = new Map<string, number>();
    for (const [am, v] of compareCountsByAm) m.set(am, v.red);
    return m;
  }, [compareCountsByAm]);

  // Phase 23.B — full-team customer list + per-AM stoplight rollup for the
  // three manager-view charts (AmStoplightStack, OutcomeBreakdownDonut,
  // TopSignalsBar). Memoized off the same snapshot.
  const allCustomers = useMemo(() => {
    if (snapshot.status !== "ready") return [];
    return snapshot.snapshot.customers;
  }, [snapshot]);

  const amStoplightRows: AmStoplightRow[] = useMemo(() => {
    if (snapshot.status !== "ready") return [];
    const byAm = new Map<string, { red: number; yellow: number; green: number }>();
    for (const c of snapshot.snapshot.customers) {
      // Phase 33.scope optionB manager amStoplightRows exclude recently_churned
      if (c.lifecycle_state === "recently_churned") continue;
      if (!c.am_name) continue;
      const entry =
        byAm.get(c.am_name) || { red: 0, yellow: 0, green: 0 };
      const sl = c.signals_v2.stoplight;
      if (sl === "RED") entry.red += 1;
      else if (sl === "YELLOW") entry.yellow += 1;
      else entry.green += 1;
      byAm.set(c.am_name, entry);
    }
    return Array.from(byAm.entries())
      .map(([am, v]) => ({ am, red: v.red, yellow: v.yellow, green: v.green }))
      .sort((a, b) => {
        if (b.red !== a.red) return b.red - a.red;
        const tA = a.red + a.yellow + a.green;
        const tB = b.red + b.yellow + b.green;
        return tB - tA;
      });
  }, [snapshot]);

  const topMovers = useMemo(() => {
    if (snapshot.status !== "ready") return [];
    const byAm = new Map<string, ScoredCustomerV2[]>();
    for (const c of snapshot.snapshot.customers) {
      // Phase 33.scope optionB manager topMovers exclude recently_churned
      // so the per-AM RED tally below doesn't pick them up.
      if (c.lifecycle_state === "recently_churned") continue;
      if (!c.am_name) continue;
      if (!byAm.has(c.am_name)) byAm.set(c.am_name, []);
      byAm.get(c.am_name)!.push(c);
    }
    const rows = Array.from(byAm.entries()).map(([am, customers]) => {
      // Phase 33.H.1 topMovers — track legacy red and new needsCall (Critical + At-risk)
      let red = 0;
      let needsCall = 0;
      let critical = 0;
      let atRisk = 0;
      let mrrAtRisk = 0;
      let flagged = 0;
      for (const c of customers) {
        if (c.signals_v2.stoplight === "RED") red += 1;
        const _htRaw = ((c as any).metabase_health?.health_tier as string | null | undefined) || "";
        const _ht =
          _htRaw === "CRITICAL - DEAL BREAKER" || _htRaw === "CRITICAL" ? "CRITICAL"
          : _htRaw === "AT-RISK" ? "AT-RISK"
          : _htRaw === "HEALTHY" ? "HEALTHY"
          : "MONITOR";
        if (_ht === "CRITICAL") critical += 1;
        if (_ht === "AT-RISK") atRisk += 1;
        if (_ht === "CRITICAL" || _ht === "AT-RISK") {
          needsCall += 1;
          mrrAtRisk += c.plan_amount || 0;
        }
        if (c.performance?.flag) flagged += 1;
      }
      const prev = compareCountsByAm.get(am);
      const needsCallPrev = prev?.needsCall;
      return {
        am,
        pod: POD_MAP[am] || "Floating",
        total: customers.length,
        red,
        needsCall,
        critical,
        atRisk,
        flagged,
        pctRed: customers.length ? (red / customers.length) * 100 : 0,
        pctNeedsCall: customers.length ? (needsCall / customers.length) * 100 : 0,
        mrrAtRisk,
        delta: needsCallPrev !== undefined ? needsCall - needsCallPrev : null,
      };
    });
    if (moverMode === "trajectory") {
      return rows
        .filter((r) => r.flagged > 0)
        .sort((a, b) => {
          if (b.flagged !== a.flagged) return b.flagged - a.flagged;
          return b.mrrAtRisk - a.mrrAtRisk;
        })
        .slice(0, 5);
    }
    return rows
      .filter((r) => r.needsCall > 0)
      .sort((a, b) => {
        if (b.needsCall !== a.needsCall) return b.needsCall - a.needsCall;
        return b.mrrAtRisk - a.mrrAtRisk;
      })
      .slice(0, 5);
  }, [snapshot, compareCountsByAm, moverMode]);

  // Fetch per-AM 14-day trend for the top movers (single bundled request)
  useEffect(() => {
    if (topMovers.length === 0) {
      setAmTrends({});
      return;
    }
    let cancelled = false;
    const amNames = topMovers.map((m) => m.am);
    (async () => {
      try {
        const params = new URLSearchParams({
          days: "14",
          ams: amNames.join(","),
        });
        const res = await fetch(`/api/v2/trends/ams?${params.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          data: { am_name: string; points: AmTrendPoint[] }[];
        };
        if (cancelled) return;
        const map: Record<string, AmTrendPoint[]> = {};
        for (const b of json.data || []) {
          map[b.am_name] = b.points;
        }
        setAmTrends(map);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [topMovers]);

  const freshnessLabel = useMemo(() => {
    if (snapshot.status !== "ready") return "loading…";
    const generatedAt = new Date(snapshot.snapshot.generatedAt).getTime();
    const now = Date.now();
    const diffMin = Math.max(0, Math.floor((now - generatedAt) / 60000));
    if (diffMin < 1) return "Updated just now";
    if (diffMin < 60) return `Updated ${diffMin} min ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `Updated ${diffHr} hr ago`;
    return `Updated ${Math.floor(diffHr / 24)} days ago`;
  }, [snapshot]);

  const snapshotDate = useMemo(() => {
    if (snapshot.status !== "ready") return "";
    return formatSnapshotDate(snapshot.snapshot.generatedAt);
  }, [snapshot]);

  const historicalDaysAgo = useMemo(() => {
    if (currentDate === "today" || !refIso) return null;
    const target = new Date(`${currentDate}T12:00:00Z`);
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    return Math.round((today.getTime() - target.getTime()) / 86400000);
  }, [currentDate, refIso]);

  // Auto-detect: when current state matches a saved view, that name lights up
  useEffect(() => {
    if (!mounted) return;
    const match = savedViews.find(
      (v) =>
        v.selectedPod === selectedPod &&
        v.currentDate === currentDate &&
        v.compareDays === compareDays,
    );
    setCurrentViewName(match ? match.name : null);
  }, [selectedPod, currentDate, compareDays, savedViews, mounted]);

  const handleJumpToAm = useCallback((am: string) => {
    if (typeof window !== "undefined") {
      window.location.href = `/customer?am=${encodeURIComponent(am)}`;
    }
  }, []);

  const handleApplyView = useCallback((v: SavedView) => {
    setSelectedPod(v.selectedPod);
    setCurrentDate(v.currentDate);
    setCompareDays(v.compareDays);
  }, []);

  const handleSaveView = useCallback(
    (name: string, overwrite: boolean): boolean => {
      const newView: SavedView = { name, selectedPod, currentDate, compareDays };
      setStoredViews((prev) => {
        const existing = prev.find((v) => v.name === name);
        if (existing && !overwrite) return prev;
        const next = [newView, ...prev.filter((v) => v.name !== name)];
        persistViews(next);
        return next;
      });
      return true;
    },
    [selectedPod, currentDate, compareDays],
  );

  const handleRenameView = useCallback(
    (oldName: string, newName: string): boolean => {
      // If renaming a default that isn't in stored yet, persist it to stored under new name
      const inStored = storedViews.find((v) => v.name === oldName);
      if (inStored) {
        setStoredViews((prev) => {
          const renamed = prev.map((v) => (v.name === oldName ? { ...v, name: newName } : v));
          // Remove duplicates by name (keep first)
          const seen = new Set<string>();
          const dedup = renamed.filter((v) => {
            if (seen.has(v.name)) return false;
            seen.add(v.name);
            return true;
          });
          persistViews(dedup);
          return dedup;
        });
        return true;
      }
      // Renaming a default — copy to stored with new name, mark old as deleted
      const def = DEFAULT_VIEWS.find((v) => v.name === oldName);
      if (def) {
        setStoredViews((prev) => {
          const next = [{ ...def, name: newName }, ...prev.filter((v) => v.name !== newName)];
          persistViews(next);
          return next;
        });
        setDeletedDefaults((prev) => {
          const next = new Set(prev);
          next.add(oldName);
          persistDeletedDefaults(next);
          return next;
        });
        return true;
      }
      return false;
    },
    [storedViews],
  );

  const handleDeleteView = useCallback((name: string) => {
    const isDefault = DEFAULT_VIEWS.some((v) => v.name === name);
    setStoredViews((prev) => {
      const next = prev.filter((v) => v.name !== name);
      persistViews(next);
      return next;
    });
    if (isDefault) {
      setDeletedDefaults((prev) => {
        const next = new Set(prev);
        next.add(name);
        persistDeletedDefaults(next);
        return next;
      });
    }
  }, []);

  const isHistorical = currentDate !== "today";

  // Comparison summary text
  const compareSummary = useMemo(() => {
    if (!kpis || !compareKpis) return null;
    const dNeedsCall = kpis.needsCall - compareKpis.needsCall;
    const dMrr = kpis.mrrAtRisk - compareKpis.mrrAtRisk;
    const dAms = kpis.amsWithAction - compareKpis.amsWithAction;
    const fmtSigned = (n: number) => (n > 0 ? `+${n}` : `${n}`);
    const fmtMoneySigned = (n: number) => (n >= 0 ? `+${formatMoney(n)}` : `-${formatMoney(-n)}`);
    return `vs ${compareDays}d ago: ${fmtSigned(dNeedsCall)} needs call · ${fmtMoneySigned(dMrr)} MRR @ risk · ${fmtSigned(dAms)} AMs w/ action`;
  }, [kpis, compareKpis, compareDays]);

  return (
    // Phase 33.brand-watchfire-T6 — Manager view canvas on Parchment.
    <div data-theme="zoca-light" className="min-h-screen text-zoca-text print:bg-white print:text-black v2-mesh-bg" style={{ background: "var(--zoca-bg)" }}>
      {/* Phase 33.brand-watchfire-T11 — page ambient layer. */}
      <BeaconAmbient />
      {snapshot.status === "ready" && (
        <FreshnessBanner generatedAt={snapshot.snapshot.generatedAt} />
      )}
      <a
        href="#manager-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:border focus:px-3 focus:py-1.5 focus:text-[12px] focus:text-zoca-text focus:bg-zoca-bg-soft focus:border-zoca-pink"
      >
        Skip to dashboard content
      </a>

      <V2Header mode="manager" generatedAt={refIso} />

      {snapshot.status === "ready" && <ScopeStrip scope={snapshot.snapshot.scope} />}

      <V2ManagerHero
        redCount={kpis?.needsCall}
        customerCount={kpis?.total}
        amCount={kpis?.amsWithAction}
        podCount={kpis?.podsRepresented}
      />

      <main id="manager-content" className="mx-auto max-w-[1400px] px-4 pb-24 pt-2 md:px-6">
        {snapshotDate && (
          <p className="mb-4 flex flex-wrap items-center justify-center gap-2 text-[11px] text-zoca-text-2">
            <span className="zoca-micro-label">Snapshot</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{snapshotDate}</span>
            {isHistorical && (
              <>
                <span
                  className="zoca-chip-amber"
                  role="status"
                >
                  Historical view
                  {historicalDaysAgo !== null
                    ? ` · ${historicalDaysAgo} day${historicalDaysAgo === 1 ? "" : "s"} ago`
                    : ""}
                </span>
                <button
                  onClick={() => setCurrentDate("today")}
                  className="text-[10px] font-semibold text-zoca-pink underline-offset-2 hover:underline focus:outline-none"
                  aria-label="Return to latest snapshot"
                >
                  Reset to today
                </button>
              </>
            )}
          </p>
        )}

        <div className="sr-only" role="status" aria-live="polite">
          {selectedPod === "All" ? "Showing all pods" : `Filtered to ${selectedPod}`}
          {compareDays > 0 ? `, comparing to ${compareDays} days ago` : ""}
          {currentDate !== "today" ? `, viewing snapshot from ${currentDate}` : ""}
        </div>

        <V2ManagerToolbar
          availableDates={availableDates}
          currentDate={currentDate}
          onDateChange={setCurrentDate}
          compareDays={compareDays}
          onCompareDaysChange={setCompareDays}
          comparisonLoading={comparisonLoading}
          savedViews={savedViews}
          currentViewName={currentViewName}
          onApplyView={handleApplyView}
          onSaveView={handleSaveView}
          onRenameView={handleRenameView}
          onDeleteView={handleDeleteView}
          refIso={refIso}
        />

        {snapshot.status === "loading" && <ManagerSkeleton />}
        {snapshot.status === "error" && (
          <div
            role="alert"
            className="rounded-2xl px-5 py-4 text-sm"
            style={{
              border: "1px solid rgba(200, 67, 29, 0.32)",
              background: "rgba(124, 45, 18, 0.06)",
              color: "var(--zoca-pink)",
            }}
          >
            <p className="font-semibold">Signal lost — couldn't load the snapshot.</p>
            <p className="mt-1 text-[12px] text-zoca-text-2">{snapshot.message}</p>
            <button
              onClick={() => setCurrentDate("today")}
              className="mt-3 inline-flex items-center gap-2 px-3 py-1 rounded-full text-[12px] font-semibold transition"
              style={{
                background: "transparent",
                color: "var(--zoca-pink)",
                border: "1px solid rgba(200, 67, 29, 0.32)",
              }}
            >
              Reset to today
            </button>
          </div>
        )}

        {snapshot.status === "ready" && kpis && (
          <>
            {/* Headline MRR-at-risk panel — Zoca brand light card */}
            <section
              aria-label="MRR at risk headline"
              className="zoca-card mb-4 zoca-fade-in"
              style={{ padding: "20px 22px" }}
            >
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="zoca-micro-label" style={{ color: "var(--zoca-pink)" }}>
                    MRR at risk this week
                  </div>
                  <div
                    className="mt-1 font-extrabold tabular-nums"
                    style={{
                      fontSize: "clamp(34px, 4vw, 44px)",
                      lineHeight: 1.02,
                      letterSpacing: "-0.035em",
                      color: "var(--zoca-pink)",
                    }}
                  >
                    <AnimatedNumber value={kpis.mrrAtRisk} duration={900} format={formatMoney} />
                  </div>
                  <div className="mt-1 text-[12px] text-zoca-text-2" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {kpis.needsCall} customer{kpis.needsCall === 1 ? "" : "s"} need a call ·{" "}
                    {kpis.amsWithAction} AM{kpis.amsWithAction === 1 ? "" : "s"} with action ·{" "}
                    {kpis.podsRepresented} pod{kpis.podsRepresented === 1 ? "" : "s"} affected
                  </div>
                </div>
                {compareKpis && (
                  <div className="flex flex-col items-end gap-1 text-right">
                    <span className="zoca-micro-label">
                      vs {compareDays}d ago
                    </span>
                    <DeltaBadge
                      delta={Math.round(kpis.mrrAtRisk - compareKpis.mrrAtRisk)}
                      unit="$"
                      lowerIsBetter
                    />
                  </div>
                )}
              </div>
              {tierTrend.length > 1 && (
                <div className="mt-3" title={`Needs-call trend last ${tierTrend.length} days (proxy for MRR-at-risk)`}>
                  <V2Sparkline
                    values={tierTrend.map((r) => r.total_high_risk)}
                    width={300}
                    height={28}
                    color="var(--zoca-pink)"
                    gradient
                    label="MRR-at-risk trend"
                  />
                </div>
              )}
            </section>

            <section
              aria-label="Top-line KPIs"
              className="mb-6 mx-0 px-0 print:static print:border-none print:bg-transparent print:p-0"
            >
              <div
                className="grid gap-3"
                style={{
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                }}
              >
                {/* Phase 33.H.1 — 4 tier tiles: Critical / At-risk / Monitor / Healthy */}
                  <Kpi
                    label="Critical"
                    value={String(kpis.critical)}
                    tone="crimson"
                    sub={`${kpis.pctCritical.toFixed(0)}% of book`}
                    delta={compareKpis ? kpis.critical - compareKpis.critical : null}
                    deltaUnit="vs prev"
                    deltaSemantic="lowerIsBetter"
                    sparkValues={tierTrend.map((r) => r.total_high_risk)}
                    sparkColor="var(--zoca-crimson, #dc2626)"
                  />
                  <Kpi
                    label="At-risk"
                    value={String(kpis.atRisk)}
                    tone="rose"
                    sub={`${kpis.pctAtRisk.toFixed(0)}% of book`}
                    delta={compareKpis ? kpis.atRisk - compareKpis.atRisk : null}
                    deltaUnit="vs prev"
                    deltaSemantic="lowerIsBetter"
                    sparkValues={tierTrend.map((r) => r.total_watch)}
                    sparkColor="var(--zoca-pink)"
                  />
                <Kpi
                    label="Monitor"
                    value={String(kpis.monitor)}
                    tone="amber"
                    delta={compareKpis ? kpis.monitor - compareKpis.monitor : null}
                    deltaUnit="vs prev"
                    deltaSemantic="neutral"
                    sparkValues={tierTrend.map((r) => r.total_medium)}
                    sparkColor="var(--zoca-amber)"
                  />
                <Kpi
                    label="Healthy"
                    value={String(kpis.healthy)}
                    tone="emerald"
                    delta={compareKpis ? kpis.healthy - compareKpis.healthy : null}
                  deltaUnit="vs prev"
                  deltaSemantic="higherIsBetter"
                  sparkValues={tierTrend.map((r) => r.total_healthy)}
                  sparkColor="var(--zoca-green)"
                />
                <Kpi
                  label="MRR @ risk"
                  value={formatMoney(kpis.mrrAtRisk)}
                  tone="rose"
                  delta={
                    compareKpis ? Math.round(kpis.mrrAtRisk - compareKpis.mrrAtRisk) : null
                  }
                  deltaUnit="$"
                  deltaSemantic="lowerIsBetter"
                />
                <Kpi
                  label="AMs w/ action"
                  value={String(kpis.amsWithAction)}
                  sub={`across ${kpis.podsRepresented} pod${kpis.podsRepresented === 1 ? "" : "s"}`}
                  delta={compareKpis ? kpis.amsWithAction - compareKpis.amsWithAction : null}
                  deltaUnit="vs prev"
                  deltaSemantic="lowerIsBetter"
                />
              </div>
              {compareSummary && (
                <p className="mt-2 text-[11px] text-zoca-text-2 text-center sm:text-left">
                  {compareSummary}
                </p>
              )}
            </section>

            {/* Phase 23.B — manager chart row (per-AM stack + outcomes donut + top signals bar) */}
            {amStoplightRows.length > 0 && (
              <section
                aria-label="Manager-view charts"
                className="zoca-fade-in"
                style={{ marginBottom: "28px" }}
              >
                <AmStoplightStack rows={amStoplightRows} />
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "10px",
                    marginTop: "10px",
                  }}
                >
                  <OutcomeBreakdownDonut daysBack={7} />
                  <TopSignalsBar customers={allCustomers} />
                </div>
              </section>
            )}

            {compareError && (
              <div
                role="alert"
                className="zoca-chip-amber mb-4 px-3 py-2"
                style={{ fontSize: "11px", letterSpacing: "0.04em", textTransform: "none" }}
              >
                Couldn't load comparison snapshot ({compareError}) — deltas disabled.
              </div>
            )}

            {topMovers.length > 0 && (
              <section
                aria-label="Top AMs by action items today"
                className="zoca-card mb-7 zoca-fade-in"
                style={{ padding: "18px 20px" }}
              >
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3
                      className="font-extrabold text-zoca-text"
                      style={{ fontSize: "17px", letterSpacing: "-0.015em" }}
                    >
                      Where to focus today
                    </h3>
                    <p className="mt-0.5 text-[11px] text-zoca-text-2">
                      Top {topMovers.length} AM{topMovers.length === 1 ? "" : "s"} by{" "}
                      {moverMode === "trajectory"
                        ? "performance-flagged count"
                        : "needs-call count (Critical + At-risk)"}
                      , MRR-at-risk tiebreaker.
                      {compareDays > 0 && compareSnapshot
                        ? ` Delta vs ${compareDays}d ago.`
                        : ""}
                    </p>
                  </div>
                  <div
                    className="inline-flex items-center gap-1 p-1 rounded-lg"
                    style={{
                      background: "var(--zoca-bg-soft)",
                      border: "1px solid var(--zoca-border)",
                    }}
                    role="tablist"
                    aria-label="Top movers sort mode"
                  >
                    <button
                      onClick={() => setMoverMode("red")}
                      role="tab"
                      aria-selected={moverMode === "red"}
                      className="px-3 py-1 rounded-md text-[11px] transition"
                      style={
                        moverMode === "red"
                          ? { background: "var(--zoca-text)", color: "#ffffff", fontWeight: 600 }
                          : { background: "transparent", color: "var(--zoca-text-2)", fontWeight: 500 }
                      }
                    >
                      Needs call
                    </button>
                    <button
                      onClick={() => setMoverMode("trajectory")}
                      role="tab"
                      aria-selected={moverMode === "trajectory"}
                      className="px-3 py-1 rounded-md text-[11px] transition"
                      style={
                        moverMode === "trajectory"
                          ? { background: "var(--zoca-text)", color: "#ffffff", fontWeight: 600 }
                          : { background: "transparent", color: "var(--zoca-text-2)", fontWeight: 500 }
                      }
                    >
                      By trajectory {"⛑"}
                    </button>
                  </div>
                </div>
                <ul className="divide-y" style={{ borderColor: "var(--zoca-border)" }}>
                  {topMovers.map((m, i) => (
                    <li
                      key={m.am}
                      className="flex items-center gap-3 py-2 text-[13px] -mx-2 px-2 rounded-md transition"
                      style={{ borderColor: "var(--zoca-border)" }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "rgba(200, 67, 29, 0.04)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span className="w-5 text-center text-[11px] font-bold text-zoca-text-2 tabular-nums">
                        #{i + 1}
                      </span>
                      <AmLink
                        amName={m.am}
                        filter="act"
                        className="font-medium text-zoca-text"
                        style={{ color: "var(--zoca-text)" }}
                      >
                        {m.am}
                      </AmLink>
                      <span className="inline-flex items-center gap-1 text-[11px] text-zoca-text-2">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${POD_COLOR_DOT[m.pod] || "bg-slate-500"}`}
                          aria-hidden
                        />
                        {m.pod}
                      </span>
                      {moverMode === "trajectory" ? (
                        <span
                          className="zoca-chip-amber ml-auto tabular-nums"
                          style={{ textTransform: "none", letterSpacing: "0.02em" }}
                          title={`${m.flagged} of ${m.total} customers have performance trajectory flagged`}
                        >
                          {"⛑"} {m.flagged} flagged
                          <span className="font-normal opacity-70 ml-1">
                            ({((m.flagged / Math.max(m.total, 1)) * 100).toFixed(0)}%)
                          </span>
                        </span>
                      ) : (
                        <span
                          className="zoca-chip-pink ml-auto tabular-nums"
                          style={{ textTransform: "none", letterSpacing: "0.02em" }}
                        >
                          {m.needsCall} NEEDS CALL
                          <span className="font-normal opacity-70 ml-1">
                            ({m.pctNeedsCall.toFixed(0)}%)
                          </span>
                        </span>
                      )}
                      {m.delta !== null && (
                        <DeltaBadge delta={m.delta} unit="needs call" lowerIsBetter />
                      )}
                      {amTrends[m.am]?.length > 1 && (
                        <span
                          className="hidden md:inline"
                          style={{ color: "var(--zoca-pink)" }}
                          title={`${m.am} needs-call trend (RED proxy), last ${amTrends[m.am].length} days`}
                        >
                          <V2Sparkline
                            values={amTrends[m.am].map((p) => p.red)}
                            width={60}
                            height={18}
                            color="var(--zoca-pink)"
                            label={`${m.am} needs-call trend`}
                          />
                        </span>
                      )}
                      <span
                        className="hidden text-[11px] tabular-nums sm:inline font-semibold"
                        style={{ color: "var(--zoca-pink)" }}
                        title="MRR at risk in this AM's book"
                      >
                        {formatMoney(m.mrrAtRisk)} @ risk
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <V2StoplightMovement
              days={Math.max(7, compareDays || 7)}
              onJumpToAm={handleJumpToAm}
            />

            <div className="mb-7">
              <V2PodSummaryGrid
                snapshot={snapshot.snapshot}
                comparison={compareSnapshot}
                selectedPod={selectedPod}
                onSelectPod={setSelectedPod}
                trends={podTrends}
              />
            </div>

            <div className="mb-7">
              <V2SignalHeatmap
                snapshot={snapshot.snapshot}
              />
            </div>

            {/* Phase 27 — Coaching loops surface above the AM activity rollup so
                managers see "who's letting things slip" before the action
                breakdown. Clicking a cell sets coachingFilter, which narrows
                V2AmActivityRollup to that single AM + shows a banner. */}
            <V2CoachingLoops
              mode="manager"
              rows={coachingRows}
              onMetricClick={(amName, metric) => setCoachingFilter({ amName, metric })}
            />

            <V2AmActivityRollup
              daysBack={7}
              coachingFilter={coachingFilter}
              onClearCoachingFilter={() => setCoachingFilter(null)}
            />

            <header className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3
                  className="font-extrabold text-zoca-text"
                  style={{ fontSize: "17px", letterSpacing: "-0.015em" }}
                >
                  Full AM rollup
                </h3>
                <p className="mt-0.5 text-[11px] text-zoca-text-2">
                  {selectedPod === "All"
                    ? "All AMs across all pods."
                    : `Filtered to ${selectedPod}. `}
                  {selectedPod !== "All" && (
                    <button
                      onClick={() => setSelectedPod("All")}
                      className="font-semibold underline-offset-2 hover:underline focus:outline-none"
                      style={{ color: "var(--zoca-pink)" }}
                    >
                      Show all pods
                    </button>
                  )}
                </p>
              </div>
            </header>

            <div>
              <V2Rollup
                snapshot={snapshot.snapshot}
                initialPod={selectedPod}
                onJumpToAm={handleJumpToAm}
              />
            </div>
          </>
        )}
      </main>

      <footer
        className="py-8 text-center print:hidden"
        style={{ borderTop: "1px solid var(--zoca-border)" }}
      >
        <div className="flex flex-col items-center gap-2 opacity-80">
          <ZocaLogo height={18} color="var(--zoca-text)" />
          <p className="text-xs text-zoca-text-2">
            Customer Health · v2 manager view · refreshed daily at 22:00 UTC
          </p>
        </div>
      </footer>
    </div>
  );
}

// Phase 22.B.3 — wrap the manager dashboard with <ToastProvider> so the
// V2SignalHeatmap cell-click toast (and any future toast usage in the
// manager tree) has a provider in scope. Phase 22.A only wired this on the
// /v2 (AM-facing) tree.
export default function V2ManagerDashboard() {
  return (
    <ToastProvider>
      <V2ManagerDashboardInner />
    </ToastProvider>
  );
}

function Kpi({
  label,
  value,
  tone,
  sub,
  delta,
  deltaUnit,
  deltaSemantic,
  sparkValues,
  sparkColor,
}: {
  label: string;
  value: string;
  tone?: "rose" | "amber" | "emerald" | "crimson";
  sub?: string;
  delta?: number | null;
  deltaUnit?: string;
  deltaSemantic?: "higherIsBetter" | "lowerIsBetter" | "neutral";
  sparkValues?: number[];
  sparkColor?: string;
}) {
  const valueColor =
    tone === "crimson"
      ? "var(--zoca-crimson, #dc2626)"
      : tone === "rose"
        ? "var(--zoca-pink)"
        : tone === "amber"
          ? "var(--zoca-amber)"
          : tone === "emerald"
            ? "var(--zoca-green)"
            : "var(--zoca-text)";
  return (
    <div className="zoca-card print:border-zinc-300 print:bg-white">
      <div className="zoca-micro-label print:text-zinc-600">{label}</div>
      <div
        className="mt-1 font-extrabold tabular-nums"
        style={{
          fontSize: "26px",
          lineHeight: 1.05,
          letterSpacing: "-0.025em",
          color: valueColor,
        }}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-[10px] text-zoca-text-2 print:text-zinc-600">{sub}</div>
      )}
      {delta !== null && delta !== undefined && (
        <div className="mt-1">
          <DeltaBadge
            delta={delta}
            unit={deltaUnit}
            lowerIsBetter={deltaSemantic === "lowerIsBetter"}
            neutral={deltaSemantic === "neutral"}
          />
        </div>
      )}
      {sparkValues && sparkValues.length > 1 && (
        <div className="mt-2 print:hidden" aria-hidden={false}>
          <V2Sparkline
            values={sparkValues}
            width={140}
            height={22}
            color={sparkColor || valueColor}
            label={`${label} trend, last ${sparkValues.length} days`}
          />
        </div>
      )}
    </div>
  );
}

function DeltaBadge({
  delta,
  unit,
  lowerIsBetter,
  neutral,
}: {
  delta: number;
  unit?: string;
  lowerIsBetter?: boolean;
  neutral?: boolean;
}) {
  if (delta === 0) {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium"
        style={{
          background: "var(--zoca-bg-soft)",
          color: "var(--zoca-text-2)",
          border: "1px solid var(--zoca-border)",
        }}
        title="No change vs comparison"
      >
        ± 0 {unit && unit !== "vs prev" ? unit : ""}
      </span>
    );
  }
  const positive = delta > 0;
  let bgStyle: React.CSSProperties;
  if (neutral) {
    bgStyle = {
      background: "var(--zoca-bg-soft)",
      color: "var(--zoca-text-2)",
      border: "1px solid var(--zoca-border)",
    };
  } else {
    const isGood = lowerIsBetter ? !positive : positive;
    bgStyle = isGood
      ? {
          background: "rgba(16,185,129,0.08)",
          color: "#047857",
          border: "1px solid rgba(16,185,129,0.22)",
        }
      : {
          background: "rgba(124, 45, 18, 0.12)",
          color: "var(--zoca-pink-bright)",
          border: "1px solid rgba(200, 67, 29, 0.22)",
        };
  }
  const arrow = positive ? "▲" : "▼";
  const abs = Math.abs(delta);
  const display =
    unit === "$" ? `$${abs.toLocaleString()}` : unit === "vs prev" ? `${abs}` : `${abs} ${unit || ""}`.trim();
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums"
      style={bgStyle}
      title={`Change vs comparison snapshot: ${positive ? "+" : "-"}${abs}${unit ? ` ${unit === "vs prev" ? "" : unit}` : ""}`}
    >
      {arrow} {display}
    </span>
  );
}

function ManagerSkeleton() {
  const tile =
    "h-20 animate-pulse rounded-2xl border bg-zoca-bg-soft";
  const tileBig =
    "h-32 animate-pulse rounded-2xl border bg-zoca-bg-soft";
  const tileXL =
    "animate-pulse rounded-2xl border bg-zoca-bg-soft";
  const borderStyle = { borderColor: "var(--zoca-border)" };
  return (
    <div className="space-y-6">
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        }}
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className={tile} style={borderStyle} />
        ))}
      </div>
      <div className={tileBig} style={borderStyle} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className={tileBig} style={borderStyle} />
        ))}
      </div>
      <div className={`${tileXL} h-48`} style={borderStyle} />
      <div className={`${tileXL} h-96`} style={borderStyle} />
    </div>
  );
}
