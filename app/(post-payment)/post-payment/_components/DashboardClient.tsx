"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ManualAnalysisButton } from "./ManualAnalysisButton";
import AmbientSparkles from "./AmbientSparkles";
import ZocaLogo from "@/components/ZocaLogo";
import { BeaconMark } from "@/components/BeaconMark";

// Lockup typography + colors — match Performance / Escalation exactly so the
// brand bar is visually identical across all three beacons.
const LOCKUP_SERIF = 'Georgia, "Times New Roman", "Times", serif';
const LOCKUP_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif";
const LOCKUP_BRASS = "#D9A441";
const LOCKUP_TEXT = "#2B1F14";
const LOCKUP_MUTED = "#6E5F50";
const LOCKUP_BORDER = "#D4C29B";

/**
 * useCountUp — tween a number from 0 → target over `duration` ms.
 * Uses requestAnimationFrame so it stays in sync with the entrance wave.
 * Easing: ease-out-quint, matching the global motion language.
 */
function useCountUp(target: number, duration = 900, delay = 0): number {
  const [val, setVal] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current;
    const to = target;
    let raf = 0;
    let started = false;
    const start = performance.now() + delay;
    const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
    const tick = (now: number) => {
      if (now < start) {
        raf = requestAnimationFrame(tick);
        return;
      }
      if (!started) started = true;
      const t = Math.min(1, (now - start) / duration);
      const v = from + (to - from) * easeOutQuint(t);
      setVal(v);
      if (t < 1) raf = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, delay]);
  return Math.round(val);
}

/** AnimatedNumber — drop-in stat-strip / donut-center number with count-up tween. */
function AnimatedNumber({ value, delay = 0, className }: { value: number; delay?: number; className?: string }) {
  const v = useCountUp(value, 900, delay);
  return <span className={`count-up ${className ?? ""}`}>{v}</span>;
}

type Customer = {
  cb_customer_id: string;
  biz_name: string | null;
  email: string | null;
  am_name: string | null;
  ae_name: string | null;
  scope: string;
  verdict: string | null;
  status: string;
  failure_reason: string | null;
  cb_created_at: string;
  primary_category: string | null;
  predicted_6_month_leads: number | null;
};

type VerdictFilter = "all" | "icp" | "review" | "not_icp" | "pending" | "failed" | "out_of_scope";

// Defensive — accept string | Date | null, never throw
function toIsoSafe(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  try { return new Date(v as any).toISOString(); } catch { return ""; }
}

function fmtDate(iso: unknown): string {
  const s = toIsoSafe(iso);
  if (!s) return "—";
  // Date-only — time is noise in the table view
  try {
    return new Date(s).toISOString().slice(0, 10);
  } catch {
    return "—";
  }
}

function verdictKey(c: Customer): VerdictFilter {
  if (c.status === "pending" || c.status === "processing") return "pending";
  if (c.status === "failed") return "failed";
  if (c.status === "out_of_scope") return "out_of_scope";
  if (c.verdict === "icp") return "icp";
  if (c.verdict === "review") return "review";
  if (c.verdict === "not_icp") return "not_icp";
  return "pending";
}

/* ──────────────────────────────────────────────
   DONUT CHART — verdict distribution (animated)
   ────────────────────────────────────────────── */
function VerdictDonut({
  data,
  selected,
  onSelect,
}: {
  data: { key: VerdictFilter; label: string; value: number; color: string; ringColor: string }[];
  selected: VerdictFilter;
  onSelect: (v: VerdictFilter) => void;
}) {
  const total = data.reduce((a, b) => a + b.value, 0);
  const r = 60;
  const stroke = 22;
  const C = 2 * Math.PI * r;
  let acc = 0;

  // Center number tweens too — bump key so it flashes on selection change
  const centerValue = selected === "all" ? total : data.find((d) => d.key === selected)?.value ?? 0;
  const centerLabel = selected === "all" ? "Total" : data.find((d) => d.key === selected)?.label ?? "Filter";

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", height: 200 }}>
      <svg width={180} height={180} viewBox="0 0 180 180">
        <circle cx={90} cy={90} r={r} fill="none" stroke="#F3F4F6" strokeWidth={stroke} />
        {data.map((d, idx) => {
          if (d.value === 0) return null;
          const pct = d.value / Math.max(total, 1);
          const len = pct * C;
          const offset = -acc * C;
          acc += pct;
          const isSelected = selected === d.key;
          return (
            <circle
              key={d.key}
              className="donut-ring"
              cx={90}
              cy={90}
              r={r}
              fill="none"
              stroke={d.color}
              strokeWidth={isSelected ? stroke + 4 : stroke}
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={offset}
              transform="rotate(-90 90 90)"
              style={{
                cursor: "pointer",
                opacity: selected === "all" || isSelected ? 1 : 0.35,
                // Stagger ring entry; shift to a higher base delay so it lands
                // just after the chart-card glide-in finishes.
                animationDelay: `${0.26 + idx * 0.08}s`,
              }}
              onClick={() => onSelect(isSelected ? "all" : d.key)}
            />
          );
        })}
      </svg>
      <div
        key={`${selected}-${centerValue}`}
        className="donut-center"
        style={{ position: "absolute", textAlign: "center", pointerEvents: "none" }}
      >
        <div style={{ fontSize: 11, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5 }}>
          {centerLabel}
        </div>
        <div style={{ fontSize: 30, fontWeight: 700, color: "#0A2540", lineHeight: 1.1 }}>
          <AnimatedNumber value={centerValue} delay={400} />
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────
   HORIZONTAL BAR CHART — AM workload
   ────────────────────────────────────────────── */
function AMBarChart({
  data,
  selectedAm,
  onSelectAm,
}: {
  data: { name: string; count: number }[];
  selectedAm: string | null;
  onSelectAm: (am: string | null) => void;
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  if (data.length === 0) {
    return <div style={{ padding: "20px 8px", fontSize: 12, color: "#6B7280" }}>No AM data yet.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
      {data.map((d, idx) => {
        const pct = (d.count / max) * 100;
        const isSelected = selectedAm === d.name;
        return (
          <div
            key={d.name}
            className="am-bar-row"
            onClick={() => onSelectAm(isSelected ? null : d.name)}
            style={{
              cursor: "pointer",
              padding: "6px 8px",
              borderRadius: 6,
              background: isSelected ? "#EFF6FF" : "transparent",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12 }}>
              <span style={{ color: isSelected ? "#1E40AF" : "#0A2540", fontWeight: isSelected ? 600 : 500 }}>{d.name}</span>
              <span style={{ color: "#6B7280", fontVariantNumeric: "tabular-nums" }}>
                <AnimatedNumber value={d.count} delay={500 + idx * 90} />
              </span>
            </div>
            <div style={{ height: 6, background: "#F3F4F6", borderRadius: 3, overflow: "hidden" }}>
              <div
                className="bar-grow"
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: isSelected ? "#2D5BFF" : "#8B5CF6",
                  borderRadius: 3,
                  transition: "background 200ms ease",
                  animationDelay: `${0.40 + idx * 0.08}s`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────
   LEAD PREDICTION TIERS — Module 02 Step 1.2 buckets
   ────────────────────────────────────────────── */
function LeadPredictionTiers({
  data,
  avg,
}: {
  data: { key: string; label: string; value: number; color: string }[];
  avg: number | null;
}) {
  const total = data.reduce((a, b) => a + b.value, 0);
  const r = 60;
  const stroke = 22;
  const C = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div>
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", height: 170 }}>
        <svg width={160} height={160} viewBox="0 0 180 180">
          <circle cx={90} cy={90} r={r} fill="none" stroke="#F3F4F6" strokeWidth={stroke} />
          {total === 0 ? null : data.map((d, idx) => {
            if (d.value === 0) return null;
            const pct = d.value / Math.max(total, 1);
            const len = pct * C;
            const offset = -acc * C;
            acc += pct;
            return (
              <circle
                key={d.key}
                className="donut-ring"
                cx={90}
                cy={90}
                r={r}
                fill="none"
                stroke={d.color}
                strokeWidth={stroke}
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={offset}
                transform="rotate(-90 90 90)"
                style={{
                  animationDelay: `${0.36 + idx * 0.08}s`,
                }}
              />
            );
          })}
        </svg>
        <div className="donut-center" style={{ position: "absolute", textAlign: "center", pointerEvents: "none" }}>
          <div style={{ fontSize: 11, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5 }}>Avg leads</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#0A2540", lineHeight: 1.1 }}>
            {avg == null ? "—" : <AnimatedNumber value={avg} delay={550} />}
          </div>
          <div style={{ fontSize: 10, color: "#9CA3AF", marginTop: 2 }}>predicted / 6mo</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6, marginTop: 12 }}>
        {data.map((d) => (
          <div key={d.key} className="flex items-center gap-2 text-xs">
            <span style={{ display: "inline-block", width: 8, height: 8, background: d.color, borderRadius: 2 }} />
            <span className="text-ink-muted">{d.label}</span>
            <span className="ml-auto text-ink-dim tabular-nums">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────
   STAT CARD with click-to-filter
   ────────────────────────────────────────────── */
function StatCard({
  label,
  value,
  tone,
  active,
  onClick,
  delay = 0,
}: {
  label: string;
  value: number;
  tone: "ink" | "green" | "yellow" | "red" | "dim";
  active: boolean;
  onClick?: () => void;
  delay?: number;
}) {
  const toneCls =
    tone === "green" ? "text-accent-green"
    : tone === "yellow" ? "text-accent-yellow"
    : tone === "red" ? "text-accent-red"
    : tone === "dim" ? "text-ink-dim"
    : "text-ink";
  return (
    <div
      onClick={onClick}
      className={`stat-card rounded-2xl border border-line bg-surface/50 backdrop-blur-sm p-4 ${active ? "stat-card-active" : ""}`}
      style={{
        cursor: onClick ? "pointer" : "default",
        borderColor: active ? "rgba(45, 91, 255, 0.5)" : undefined,
        background: active ? "rgba(239, 246, 255, 0.6)" : undefined,
      }}
    >
      <div className="text-xs text-ink-dim">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${toneCls}`}>
        <AnimatedNumber value={value} delay={delay} />
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────
   VERDICT PILL
   ────────────────────────────────────────────── */
function VerdictPill({ c }: { c: Customer }) {
  if (c.status === "pending" || c.status === "processing") {
    return (
      <span className="verdict-pill inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-elevated border border-line text-ink-dim text-xs">
        <span className="live-dot" /> {c.status}
      </span>
    );
  }
  if (c.status === "failed") {
    return (
      <span
        className="verdict-pill inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-red-bg border border-accent-red/40 text-accent-red text-xs font-medium"
        title={c.failure_reason ?? ""}
      >
        ⚠️ failed
      </span>
    );
  }
  if (c.scope !== "discovery_first_pay") {
    const reason =
      c.scope === "no_subscription" ? "no sub yet"
      : c.scope === "other_subscription" ? "non-Discovery"
      : c.scope === "discovery_addon" ? "Discovery add-on"
      : c.scope === "pre_floor" ? "pre-floor"
      : c.scope;
    return <span className="text-ink-dim text-xs">— {reason}</span>;
  }
  if (c.verdict === "icp")
    return <span className="verdict-pill inline-flex items-center px-2.5 py-0.5 rounded-full bg-accent-green-bg border border-accent-green/40 text-accent-green text-xs font-semibold">✅ ICP</span>;
  if (c.verdict === "review")
    return <span className="verdict-pill inline-flex items-center px-2.5 py-0.5 rounded-full bg-accent-yellow-bg border border-accent-yellow/40 text-accent-yellow text-xs font-semibold">⚠️ Review</span>;
  if (c.verdict === "not_icp")
    return <span className="verdict-pill inline-flex items-center px-2.5 py-0.5 rounded-full bg-accent-red-bg border border-accent-red/40 text-accent-red text-xs font-semibold">❌ Not ICP</span>;
  return <span className="text-ink-dim text-xs">—</span>;
}

function ScopeChip({ scope }: { scope: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    discovery_first_pay: { label: "Discovery first-pay", cls: "bg-accent-blue-bg text-accent-blue-strong border border-accent-blue/30" },
    discovery_addon: { label: "Discovery add-on", cls: "bg-accent-purple-bg text-accent-purple-strong border border-accent-purple/30" },
    other_subscription: { label: "Non-Discovery sub", cls: "bg-elevated text-ink-muted border border-line" },
    no_subscription: { label: "No sub yet", cls: "bg-elevated text-ink-dim border border-line" },
    pre_floor: { label: "Pre-floor", cls: "bg-accent-yellow-bg text-accent-yellow border border-accent-yellow/30" },
    pending: { label: "Pending", cls: "bg-elevated text-ink-dim border border-line" },
  };
  const v = map[scope] ?? { label: scope, cls: "bg-elevated text-ink-muted border border-line" };
  return <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${v.cls}`}>{v.label}</span>;
}

function Feature({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5"><span className="text-accent-pink">•</span>{children}</span>;
}

/* ──────────────────────────────────────────────
   MAIN CLIENT DASHBOARD
   ────────────────────────────────────────────── */
type SortKey = "created_desc" | "created_asc" | "biz_asc" | "verdict";

export default function DashboardClient({ customers }: { customers: Customer[] }) {
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedAm, setSelectedAm] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("created_desc");

  // Totals
  const totals = useMemo(() => {
    const t = { all: customers.length, icp: 0, review: 0, not_icp: 0, out_of_scope: 0, pending: 0, failed: 0 };
    for (const c of customers) {
      const k = verdictKey(c);
      if (k in t) (t as any)[k]++;
    }
    return t;
  }, [customers]);

  // Donut data
  const donutData = useMemo(
    () => [
      { key: "icp" as const, label: "ICP", value: totals.icp, color: "#10B981", ringColor: "#D1FAE5" },
      { key: "review" as const, label: "Review", value: totals.review, color: "#F59E0B", ringColor: "#FEF3C7" },
      { key: "not_icp" as const, label: "Not ICP", value: totals.not_icp, color: "#EF4444", ringColor: "#FEE2E2" },
      { key: "pending" as const, label: "Pending", value: totals.pending, color: "#94A3B8", ringColor: "#F1F5F9" },
      { key: "failed" as const, label: "Failed", value: totals.failed, color: "#BE185D", ringColor: "#FCE7F3" },
      { key: "out_of_scope" as const, label: "Out of scope", value: totals.out_of_scope, color: "#CBD5E1", ringColor: "#F1F5F9" },
    ],
    [totals]
  );

  // AM workload
  const amCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of customers) {
      if (!c.am_name) continue;
      m.set(c.am_name, (m.get(c.am_name) ?? 0) + 1);
    }
    return Array.from(m.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [customers]);

  // Module 02 Step 1.2 lead prediction tiers
  // Autofail <30 · Possible 30–60 · Likely >60 · Unknown (null)
  const leadTiers = useMemo(() => {
    const buckets = { autofail: 0, possible: 0, likely: 0, unknown: 0 };
    let sum = 0;
    let n = 0;
    for (const c of customers) {
      const v = c.predicted_6_month_leads;
      if (v == null) {
        buckets.unknown++;
      } else if (v < 30) {
        buckets.autofail++;
        sum += v;
        n++;
      } else if (v <= 60) {
        buckets.possible++;
        sum += v;
        n++;
      } else {
        buckets.likely++;
        sum += v;
        n++;
      }
    }
    const data = [
      { key: "autofail", label: "Autofail (<30)", value: buckets.autofail, color: "#EF4444" },
      { key: "possible", label: "Possible (30–60)", value: buckets.possible, color: "#F59E0B" },
      { key: "likely", label: "Likely (>60)", value: buckets.likely, color: "#10B981" },
      { key: "unknown", label: "Unknown", value: buckets.unknown, color: "#CBD5E1" },
    ];
    const avg = n > 0 ? Math.round(sum / n) : null;
    return { data, avg };
  }, [customers]);

  // Filtered + sorted rows
  const rows = useMemo(() => {
    let r = customers.slice();
    if (verdictFilter !== "all") r = r.filter((c) => verdictKey(c) === verdictFilter);
    if (selectedAm) r = r.filter((c) => c.am_name === selectedAm);
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter(
        (c) =>
          (c.biz_name ?? "").toLowerCase().includes(q) ||
          c.cb_customer_id.toLowerCase().includes(q) ||
          (c.email ?? "").toLowerCase().includes(q)
      );
    }
    r.sort((a, b) => {
      const aIso = toIsoSafe(a.cb_created_at);
      const bIso = toIsoSafe(b.cb_created_at);
      if (sort === "created_desc") return bIso.localeCompare(aIso);
      if (sort === "created_asc") return aIso.localeCompare(bIso);
      if (sort === "biz_asc") return (a.biz_name ?? "").localeCompare(b.biz_name ?? "");
      if (sort === "verdict") return verdictKey(a).localeCompare(verdictKey(b));
      return 0;
    });
    return r;
  }, [customers, verdictFilter, selectedAm, search, sort]);

  const refreshTime = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  });

  return (
    <div className="space-y-8 sm:space-y-10 relative">
      <AmbientSparkles />

      {/*
        Top brand bar — ZOCA wordmark | divider | animated flame + Beacon.
        Mirrors the lockup used on Performance and Escalation so all three
        beacons share an identical top edge. Lives inside DashboardClient
        because we want the visual signature on the landing page; the single
        report page has its own "← All reports" back link.
      */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px 0",
          marginBottom: 8,
          borderBottom: `1px solid ${LOCKUP_BORDER}`,
        }}
      >
        <Link
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <ZocaLogo height={22} />
          <span
            style={{
              width: 1,
              height: 22,
              background: LOCKUP_BORDER,
              display: "inline-block",
            }}
            aria-hidden
          />
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <BeaconMark size={26} flicker />
            <span
              style={{
                fontFamily: LOCKUP_SERIF,
                fontWeight: 500,
                fontSize: 18,
                letterSpacing: 0,
                color: LOCKUP_TEXT,
              }}
            >
              Beacon
            </span>
          </span>
        </Link>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: LOCKUP_SANS,
            fontSize: 11,
            letterSpacing: "0.12em",
            color: LOCKUP_MUTED,
            textTransform: "uppercase",
          }}
        >
          <span
            className="pp-pulse-dot"
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: LOCKUP_BRASS,
            }}
            aria-hidden
          />
          Post-Payment Beacon · Live
        </div>
      </header>

      {/* HERO */}
      <section className="anim-rise pt-8 sm:pt-12 relative flex flex-col items-center text-center">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-line bg-surface/50">
          <span className="live-dot" />
          <span className="text-sm text-ink-muted">Live Chargebee + Stripe + Metabase · auto-scored by Claude</span>
        </div>
        <div className="relative inline-block mt-6 sm:mt-8">
          <span aria-hidden className="header-spark text-accent-pink text-sm" style={{ top: "-12px", left: "-22px", animationDelay: "0s" }}>✦</span>
          <span aria-hidden className="header-spark text-accent-purple text-xs" style={{ top: "-4px", right: "-26px", animationDelay: "0.7s" }}>✦</span>
          <span aria-hidden className="header-spark text-accent-yellow text-sm" style={{ bottom: "8px", right: "-12px", animationDelay: "1.4s" }}>✦</span>
          <h1 className="hero-float text-pink-shimmer text-5xl sm:text-6xl lg:text-7xl xl:text-8xl font-extrabold tracking-tight leading-[0.95] m-0">
            Post-Payment Reviews
          </h1>
        </div>
        <p className="mt-4 sm:mt-6 max-w-2xl text-sm sm:text-base lg:text-lg text-ink-muted leading-relaxed">
          Which new Discovery customers Zoca should keep, route to an AM, or refund — auto-generated the moment a Chargebee <code className="font-mono text-accent-pink">customer.created</code> webhook fires.
        </p>
        <div className="mt-5 sm:mt-7 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-ink-muted">
          <Feature>Module 02 ICP framework</Feature>
          <Feature>11-section Word doc per customer</Feature>
          <Feature>Slack auto-post on verdict</Feature>
        </div>
      </section>

      {/* STATUS BAR */}
      <section className="anim-rise rounded-2xl border border-line bg-surface/50 backdrop-blur-sm px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between flex-wrap gap-3" style={{ animationDelay: "0.10s" }}>
        <div className="text-xs sm:text-sm text-ink-muted">
          <span className="text-ink-dim mr-2">SHOWING</span>
          <span className="text-ink font-semibold">{rows.length}</span>
          <span className="text-ink-dim mx-1">/ {customers.length}</span>
          <span className="text-ink-dim mx-2 sm:mx-3">·</span>
          <span className="text-ink-dim mr-2">LAST REFRESH</span>
          <span className="text-ink font-semibold tabular-nums">{refreshTime}</span>
        </div>
        <button
          onClick={() => { setVerdictFilter("all"); setSelectedAm(null); setSearch(""); }}
          className="btn-bounce text-xs text-ink-dim hover:text-accent-blue transition px-3 py-1 rounded border border-line hover:border-accent-blue"
        >
          Clear filters
        </button>
      </section>

      {/* STAT STRIP — click to filter. Delays cascade across the strip so
          numbers count up in a wave. */}
      <section className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 anim-cascade">
        <StatCard label="Total since floor" value={totals.all}        tone="ink"    active={verdictFilter === "all"}          onClick={() => setVerdictFilter("all")}                                                                       delay={220} />
        <StatCard label="✅ ICP"            value={totals.icp}        tone="green"  active={verdictFilter === "icp"}          onClick={() => setVerdictFilter(verdictFilter === "icp" ? "all" : "icp")}                                     delay={260} />
        <StatCard label="⚠️ Review"         value={totals.review}     tone="yellow" active={verdictFilter === "review"}       onClick={() => setVerdictFilter(verdictFilter === "review" ? "all" : "review")}                               delay={300} />
        <StatCard label="❌ Not ICP"        value={totals.not_icp}    tone="red"    active={verdictFilter === "not_icp"}      onClick={() => setVerdictFilter(verdictFilter === "not_icp" ? "all" : "not_icp")}                             delay={340} />
        <StatCard label="Out of scope"     value={totals.out_of_scope} tone="dim"  active={verdictFilter === "out_of_scope"} onClick={() => setVerdictFilter(verdictFilter === "out_of_scope" ? "all" : "out_of_scope")}                  delay={380} />
        <StatCard label="Pending"          value={totals.pending}     tone="dim"   active={verdictFilter === "pending"}      onClick={() => setVerdictFilter(verdictFilter === "pending" ? "all" : "pending")}                             delay={420} />
        <StatCard label="Failed"           value={totals.failed}      tone="red"   active={verdictFilter === "failed"}       onClick={() => setVerdictFilter(verdictFilter === "failed" ? "all" : "failed")}                               delay={460} />
      </section>

      {/* CHARTS GRID — three equal-height cards, lined up with flex */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 anim-rise items-stretch" style={{ animationDelay: "0.22s" }}>
        <div className="chart-card rounded-2xl border border-line bg-surface p-5 flex flex-col">
          <div className="text-xs text-ink-dim uppercase tracking-wide font-medium mb-3">Verdict distribution</div>
          <VerdictDonut data={donutData} selected={verdictFilter} onSelect={setVerdictFilter} />
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-auto pt-3 text-xs">
            {donutData.map((d) => (
              <div
                key={d.key}
                onClick={() => setVerdictFilter(verdictFilter === d.key ? "all" : d.key)}
                style={{ cursor: "pointer" }}
                className="flex items-center gap-2 hover:text-accent-blue transition"
              >
                <span style={{ display: "inline-block", width: 8, height: 8, background: d.color, borderRadius: 2 }} />
                <span className="text-ink-muted">{d.label}</span>
                <span className="ml-auto text-ink-dim tabular-nums">{d.value}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="chart-card rounded-2xl border border-line bg-surface p-5 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-ink-dim uppercase tracking-wide font-medium">AM workload</div>
            {selectedAm && (
              <button onClick={() => setSelectedAm(null)} className="text-xs text-accent-blue hover:underline">clear</button>
            )}
          </div>
          <div className="flex-1">
            <AMBarChart data={amCounts} selectedAm={selectedAm} onSelectAm={setSelectedAm} />
          </div>
        </div>
        <div className="chart-card rounded-2xl border border-line bg-surface p-5 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-ink-dim uppercase tracking-wide font-medium">Lead prediction tiers</div>
            <div className="text-[10px] text-ink-faint">Module 02 · Step 1.2</div>
          </div>
          <LeadPredictionTiers data={leadTiers.data} avg={leadTiers.avg} />
        </div>
      </section>

      {/* FILTER BAR */}
      <section className="rounded-2xl border border-line bg-surface px-4 py-3 flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search business name, customer ID, email…"
          className="flex-1 min-w-[200px] px-3 py-1.5 text-sm rounded-lg border border-line bg-elevated focus:outline-none focus:border-accent-blue focus:bg-surface transition"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="px-3 py-1.5 text-sm rounded-lg border border-line bg-surface hover:border-accent-blue cursor-pointer transition"
        >
          <option value="created_desc">Newest first</option>
          <option value="created_asc">Oldest first</option>
          <option value="biz_asc">Business name A→Z</option>
          <option value="verdict">By verdict</option>
        </select>
      </section>

      {/* TABLE */}
      <section className="rounded-2xl border border-line bg-surface overflow-hidden anim-rise" style={{ animationDelay: "0.32s" }}>
        <table className="w-full text-sm">
          <colgroup>
            <col style={{ width: "108px" }} />
            <col />
            <col />
            <col style={{ width: "130px" }} />
            <col style={{ width: "130px" }} />
            <col style={{ width: "150px" }} />
            <col style={{ width: "130px" }} />
            <col style={{ width: "140px" }} />
          </colgroup>
          <thead className="bg-elevated text-ink-dim uppercase tracking-wide text-xs">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Created</th>
              <th className="text-left px-4 py-3 font-medium">Customer</th>
              <th className="text-left px-4 py-3 font-medium">Email</th>
              <th className="text-left px-4 py-3 font-medium">AE</th>
              <th className="text-left px-4 py-3 font-medium">AM</th>
              <th className="text-left px-4 py-3 font-medium">Scope</th>
              <th className="text-left px-4 py-3 font-medium">Verdict</th>
              <th className="text-right px-4 py-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center py-12 text-ink-faint">
                  No customers match the current filters. <button onClick={() => { setVerdictFilter("all"); setSelectedAm(null); setSearch(""); }} className="text-accent-blue hover:underline">Clear filters</button>
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.cb_customer_id} className="table-row-anim row-sweep border-t border-line-soft hover:bg-elevated transition-colors">
                <td className="px-4 py-3 text-ink-muted whitespace-nowrap tabular-nums">{fmtDate(c.cb_created_at)}</td>
                <td className="px-4 py-3">
                  <div className="font-semibold text-ink">{c.biz_name ?? "(no biz)"}</div>
                  <div className="text-xs text-ink-dim font-mono">{c.cb_customer_id}</div>
                </td>
                <td className="px-4 py-3 text-ink-muted truncate">{c.email ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted whitespace-nowrap">{c.ae_name ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted whitespace-nowrap">{c.am_name ?? "—"}</td>
                <td className="px-4 py-3"><ScopeChip scope={c.scope} /></td>
                <td className="px-4 py-3"><VerdictPill c={c} /></td>
                <td className="px-4 py-3 text-right">
                  {c.status === "ready" ? (
                    <Link href={`/post-payment/reports/${c.cb_customer_id}`} className="report-link text-accent-blue font-medium hover:text-accent-blue-strong transition group">
                      Open report <span className="link-arrow inline-block">→</span>
                    </Link>
                  ) : c.status === "out_of_scope" ? (
                    <span className="text-ink-faint">—</span>
                  ) : (
                    <ManualAnalysisButton customerId={c.cb_customer_id} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
