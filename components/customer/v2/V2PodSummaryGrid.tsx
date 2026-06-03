"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (7 hex/rgba + 0 tailwind-rose swept)

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import type { SnapshotV2, ScoredCustomerV2 } from "@/lib/customer/types";
import type { Stoplight } from "@/lib/customer/config";
import V2Sparkline from "./V2Sparkline";
import { POD_MAP } from "@/lib/customer/config";
import { useToast } from "./Toast";

const POD_ORDER = ["Pod 1", "Pod 2", "Pod 3", "Pod 4", "Pod 5", "Floating"];

// Phase 33.brand-watchfire-T5 — pod indicator dots → Watchfire palette.
const POD_COLOR_DOT: Record<string, string> = {
  "Pod 1": "bg-[#2A4D5C]", // Sea Lapis
  "Pod 2": "bg-[#4A7C59]", // Patina
  "Pod 3": "bg-[#D9A441]", // Brass
  "Pod 4": "bg-[#C8431D]", // Ember
  "Pod 5": "bg-[#7C2D12]", // Deep Crimson
  Floating: "bg-[#6E5F50]", // Smoke
};

type PodSummary = {
  pod: string;
  ams: string[];
  // Phase 33.H.3a — topAms now ranks by needsCall (Critical + At-risk) count
  topAms: { am: string; needsCall: number }[];
  total: number;
  RED: number;
  YELLOW: number;
  GREEN: number;
  // Phase 33.H.3a — 4-tier health_tier counts (MONITOR fallback)
  critical: number;
  atRisk: number;
  monitor: number;
  healthy: number;
  needsCall: number;
  pctRed: number;
  pctNeedsCall: number;
  mrr: number;
  mrrAtRisk: number;
  topSignal: TopSignal | null;
  redDelta: number | null;
  needsCallDelta: number | null;
  flagged: number;
};

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `$${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return n > 0 ? `$${Math.round(n).toLocaleString()}` : "$0";
}

type TopSignal = {
  // user-facing label
  label: string;
  // signal-taxonomy key (matches lib/signal-taxonomy.ts SignalKey union)
  key: "we_silent" | "client_silent" | "resp_drop" | "vol_collapse" | "usage_low" | "billing";
};

function classifyTopSignal(customers: ScoredCustomerV2[]): TopSignal | null {
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
  if (!ranked[0] || ranked[0][1] === 0) return null;
  const meta: Record<string, TopSignal> = {
    we: { label: "We silent", key: "we_silent" },
    client: { label: "Client silent", key: "client_silent" },
    drop: { label: "Resp drop", key: "resp_drop" },
    vol: { label: "Vol collapse", key: "vol_collapse" },
    usage: { label: "Usage low", key: "usage_low" },
    billing: { label: "Billing", key: "billing" },
  };
  return meta[ranked[0][0]] || null;
}

type PodTrendPoint = {
  date: string;
  red: number;
  yellow: number;
  green: number;
  total: number;
};

type Props = {
  snapshot: SnapshotV2;
  comparison?: SnapshotV2 | null;
  selectedPod: string;
  onSelectPod: (pod: string) => void;
  trends?: Record<string, PodTrendPoint[]>; // pod name -> daily series
};

export default function V2PodSummaryGrid({
  snapshot,
  comparison,
  selectedPod,
  onSelectPod,
  trends,
}: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const summaries = useMemo<PodSummary[]>(() => {
    // Phase 33.H.3a — track both legacy red AND new needsCall (Critical + At-risk) per pod
    const compareCountsByPod = new Map<string, { red: number; needsCall: number }>();
    if (comparison) {
      for (const c of comparison.customers) {
        // F-purge-churned — snapshot excludes recently-churned rows.
        const pod = POD_MAP[c.am_name] || "Floating";
        const entry = compareCountsByPod.get(pod) || { red: 0, needsCall: 0 };
        if (c.signals_v2.stoplight === "RED") entry.red += 1;
        const _htRaw = ((c as any).metabase_health?.health_tier as string | null | undefined) || "";
        const _ht =
          _htRaw === "CRITICAL - DEAL BREAKER" || _htRaw === "CRITICAL" ? "CRITICAL"
          : _htRaw === "AT-RISK" ? "AT-RISK"
          : _htRaw === "HEALTHY" ? "HEALTHY"
          : "MONITOR";
        if (_ht === "CRITICAL" || _ht === "AT-RISK") entry.needsCall += 1;
        compareCountsByPod.set(pod, entry);
      }
    }

    const byPod = new Map<string, ScoredCustomerV2[]>();
    // Phase 33.H.3a — per-AM needsCall tally (replaces former red-based tally)
    const amsByPod = new Map<string, Map<string, number>>();
    for (const c of snapshot.customers) {
      // F-purge-churned — snapshot excludes recently-churned rows.
      const pod = POD_MAP[c.am_name] || "Floating";
      if (!byPod.has(pod)) byPod.set(pod, []);
      if (!amsByPod.has(pod)) amsByPod.set(pod, new Map());
      byPod.get(pod)!.push(c);
      if (c.am_name) {
        const amMap = amsByPod.get(pod)!;
        const prev = amMap.get(c.am_name) || 0;
        const _htRaw = ((c as any).metabase_health?.health_tier as string | null | undefined) || "";
        const _ht =
          _htRaw === "CRITICAL - DEAL BREAKER" || _htRaw === "CRITICAL" ? "CRITICAL"
          : _htRaw === "AT-RISK" ? "AT-RISK"
          : _htRaw === "HEALTHY" ? "HEALTHY"
          : "MONITOR";
        amMap.set(c.am_name, prev + ((_ht === "CRITICAL" || _ht === "AT-RISK") ? 1 : 0));
      }
    }
    return POD_ORDER.map<PodSummary>((pod) => {
      const list = byPod.get(pod) || [];
      const counts: Record<Stoplight, number> = { RED: 0, YELLOW: 0, GREEN: 0 };
      // Phase 33.H.3a — 4-tier counts (MONITOR fallback for missing metabase_health)
      let critical = 0;
      let atRisk = 0;
      let monitor = 0;
      let healthy = 0;
      let mrr = 0;
      let mrrAtRisk = 0;
      let flagged = 0;
      for (const c of list) {
        const sl = c.signals_v2.stoplight;
        counts[sl] += 1;
        const plan = c.plan_amount || 0;
        mrr += plan;
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
        // MRR-at-risk now uses Critical + At-risk (the "needs call" semantic)
        if (_ht === "CRITICAL" || _ht === "AT-RISK") mrrAtRisk += plan;
        if (c.performance?.flag) flagged += 1;
      }
      const needsCall = critical + atRisk;
      const amMap = amsByPod.get(pod) || new Map();
      const ams = Array.from(amMap.keys()).sort();
      const topAms = Array.from(amMap.entries())
        .map(([am, needsCall]) => ({ am, needsCall }))
        .sort((a, b) => b.needsCall - a.needsCall)
        .slice(0, 3);
      const prevCounts = compareCountsByPod.get(pod);
      return {
        pod,
        ams,
        topAms,
        total: list.length,
        RED: counts.RED,
        YELLOW: counts.YELLOW,
        GREEN: counts.GREEN,
        critical,
        atRisk,
        monitor,
        healthy,
        needsCall,
        pctRed: list.length ? (counts.RED / list.length) * 100 : 0,
        pctNeedsCall: list.length ? (needsCall / list.length) * 100 : 0,
        mrr,
        mrrAtRisk,
        topSignal: classifyTopSignal(list),
        redDelta: comparison && prevCounts ? counts.RED - prevCounts.red : null,
        needsCallDelta: comparison && prevCounts ? needsCall - prevCounts.needsCall : null,
        flagged,
      };
    });
  }, [snapshot, comparison]);

  return (
    <section aria-label="Pod summary">
      <header className="mt-2 mb-3 flex items-end justify-between gap-3">
        <div>
          <h3
            className="font-extrabold text-zoca-text"
            style={{ fontSize: "17px", letterSpacing: "-0.015em" }}
          >
            Pods
          </h3>
          <p className="mt-0.5 text-[11px] text-zoca-text-2">
            Click any pod to filter the rollup below.
            {comparison ? " Delta badges compare to your selected comparison snapshot." : ""}
          </p>
        </div>
        {selectedPod !== "All" && (
          <button
            onClick={() => onSelectPod("All")}
            className="text-[11px] font-semibold underline-offset-2 hover:underline focus:outline-none"
            style={{ color: "var(--zoca-pink)" }}
            aria-label="Clear pod selection"
          >
            Show all pods
          </button>
        )}
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {summaries.map((s) => {
          const active = s.pod === selectedPod;
          const r = s.total ? (s.RED / s.total) * 100 : 0;
          const y = s.total ? (s.YELLOW / s.total) * 100 : 0;
          const g = s.total ? (s.GREEN / s.total) * 100 : 0;
            // Phase 33.H.3a — 4-tier percentages for the spread bar
            const cr = s.total ? (s.critical / s.total) * 100 : 0;
            const ar = s.total ? (s.atRisk / s.total) * 100 : 0;
            const mo = s.total ? (s.monitor / s.total) * 100 : 0;
            const he = s.total ? (s.healthy / s.total) * 100 : 0;
          return (
            <button
              key={s.pod}
              onClick={() => onSelectPod(active ? "All" : s.pod)}
              aria-pressed={active}
              aria-label={`${s.pod}: ${s.total} customers, ${s.needsCall} needs call, ${formatMoney(s.mrrAtRisk)} MRR at risk. Click to ${active ? "clear" : "filter"}.`}
              className="group flex flex-col rounded-2xl px-3 py-3 text-left transition-all duration-150 ease-out focus:outline-none"
              style={
                active
                  ? {
                      border: "1px solid var(--zoca-pink)",
                      background:
                        "linear-gradient(180deg, rgba(200, 67, 29, 0.04), rgba(252, 228, 214, 0.06)), #fff",
                      boxShadow:
                        "0 0 0 1px rgba(200, 67, 29, 0.35), 0 0 24px rgba(252, 228, 214, 0.35)",
                    }
                  : {
                      // Phase 33.brand-watchfire-T6 — Light Parchment surface, not white.
                      border: "1px solid var(--zoca-border)",
                      background: "var(--zoca-bg-soft)",
                      boxShadow: "0 1px 3px rgba(43,31,20,0.04)",
                    }
              }
              onMouseEnter={(e) => {
                if (active) return;
                // Phase 33.brand-watchfire-T6 — Ember hover.
                e.currentTarget.style.transform = "translateY(-2px)";
                e.currentTarget.style.borderColor = "rgba(200, 67, 29, 0.30)";
                e.currentTarget.style.boxShadow =
                  "0 12px 28px -8px rgba(43,31,20,0.12), 0 0 0 1px rgba(200, 67, 29, 0.22), 0 0 32px rgba(252, 228, 214, 0.40)";
              }}
              onMouseLeave={(e) => {
                if (active) return;
                e.currentTarget.style.transform = "";
                e.currentTarget.style.borderColor = "var(--zoca-border)";
                e.currentTarget.style.boxShadow = "0 1px 3px rgba(11,5,29,0.04)";
              }}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-2 w-2 rounded-full ${POD_COLOR_DOT[s.pod] || "bg-slate-500"}`}
                  aria-hidden
                />
                <span className="text-[12px] font-semibold text-zoca-text">{s.pod}</span>
                <span className="ml-auto text-[10px] text-zoca-text-2">
                  {s.ams.length} AM{s.ams.length === 1 ? "" : "s"}
                </span>
              </div>

              <div className="mt-2 flex items-baseline justify-between">
                <span
                  className="font-extrabold tabular-nums text-zoca-text"
                  style={{ fontSize: "22px", letterSpacing: "-0.025em", lineHeight: 1 }}
                >
                  {s.total}
                </span>
                <span className="text-[10px] text-zoca-text-2">customers</span>
              </div>

              <div
                className="mt-1 flex h-1 w-full overflow-hidden rounded-full"
                style={{ background: "var(--zoca-bg-soft)" }}
                role="img"
                aria-label={`Tier spread: ${s.critical} Critical, ${s.atRisk} At-risk, ${s.monitor} Monitor, ${s.healthy} Healthy`}
                title={`${s.critical} CRIT · ${s.atRisk} AT-RISK · ${s.monitor} MONITOR · ${s.healthy} HEALTHY`}
              >
                {cr > 0 && <div style={{ width: `${cr}%`, background: "var(--zoca-crimson, #dc2626)" }} />}
                  {ar > 0 && <div style={{ width: `${ar}%`, background: "var(--zoca-pink)" }} />}
                  {/* legacy r/y/g vars kept for back-compat but not rendered (replaced by cr/ar/mo/he) */}
                  {/* r/y/g unused on render path */}
                  {mo > 0 && <div style={{ width: `${mo}%`, background: "var(--zoca-amber)" }} />}
                  {he > 0 && <div style={{ width: `${he}%`, background: "var(--zoca-green)" }} />}
                {y > 0 && <div style={{ width: `${y}%`, background: "var(--zoca-amber)" }} />}
                {g > 0 && <div style={{ width: `${g}%`, background: "var(--zoca-green)" }} />}
              </div>
              {trends && trends[s.pod] && trends[s.pod].length > 1 && (
                <div
                  className="mt-2 print:hidden"
                  style={{ color: "var(--zoca-pink)" }}
                  title={`Needs-call trend (RED proxy) for ${s.pod} over the last ${trends[s.pod].length} days`}
                >
                  <V2Sparkline
                    values={trends[s.pod].map((pt) => pt.red)}
                    width={120}
                    height={18}
                    color="var(--zoca-pink)"
                    gradient
                    label={`${s.pod} needs-call trend`}
                  />
                </div>
              )}

              <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
                <div className="text-zoca-text-2">Needs call</div>
                <div className="text-right font-semibold tabular-nums" style={{ color: "var(--zoca-pink)" }}>
                  {s.needsCall} <span className="text-zoca-text-2">({s.pctNeedsCall.toFixed(0)}%)</span>
                </div>
                <div className="text-zoca-text-2">MRR</div>
                <div className="text-right tabular-nums text-zoca-text">
                  {formatMoney(s.mrr)}
                </div>
                <div className="text-zoca-text-2">@ risk</div>
                <div className="text-right tabular-nums" style={{ color: "var(--zoca-pink)" }}>
                  {formatMoney(s.mrrAtRisk)}
                </div>
                <div className="text-zoca-text-2" title="Performance-flagged customers in this pod">{"⛑"} Flagged</div>
                <div
                  className="text-right tabular-nums"
                  title={s.flagged ? `${s.flagged} of ${s.total} (${((s.flagged / Math.max(s.total, 1)) * 100).toFixed(0)}%)` : "None flagged"}
                >
                  {s.flagged > 0 ? (
                    <span style={{ color: "var(--zoca-pink)" }}>{s.flagged}</span>
                  ) : (
                    <span className="text-zoca-text-3">·</span>
                  )}
                </div>
              </div>

              {s.needsCallDelta !== null && (
                <div className="mt-2">
                  <PodDeltaPill delta={s.needsCallDelta} />
                </div>
              )}

              {s.topSignal && (
                <div
                  className="mt-2 truncate text-[10px] text-zoca-text-2"
                  title={`Most common strong signal across ${s.pod}: ${s.topSignal.label}. Click to drill into ${s.pod} \u00D7 ${s.topSignal.label}.`}
                >
                  Mostly:{" "}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      // Phase 24 — drill into /v2 with both pod + signal pre-applied.
                      const sigKey = s.topSignal!.key;
                      const podLabel = s.pod;
                      const qs = new URLSearchParams();
                      qs.set("pod", podLabel);
                      qs.set("signal", sigKey);
                      router.push(`/customer?${qs.toString()}`);
                      showToast(
                        `Filtered to ${podLabel} \u00D7 ${s.topSignal!.label}`,
                        { type: "info", icon: "filter" },
                      );
                    }}
                    className="font-medium text-zoca-text rounded px-1 -mx-1 transition cursor-pointer focus:outline-none"
                    style={{ background: "transparent", border: 0 }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "var(--zoca-blue)";
                      e.currentTarget.style.textDecoration = "underline";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "";
                      e.currentTarget.style.textDecoration = "";
                    }}
                  >
                    {s.topSignal.label}
                  </button>
                </div>
              )}

              {s.topAms.length > 0 && s.topAms[0].needsCall > 0 && (
                <div
                  className="mt-1 truncate text-[10px] text-zoca-text-2"
                  title={`Top AMs by needs call: ${s.topAms.map((a) => `${a.am} (${a.needsCall})`).join(", ")}`}
                >
                  Hotspot:{" "}
                  <span className="font-medium text-zoca-text">
                    {s.topAms
                      .filter((a) => a.needsCall > 0)
                      .slice(0, 2)
                      .map((a) => `${a.am.split(" ")[0]} (${a.needsCall})`)
                      .join(" · ")}
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PodDeltaPill({ delta }: { delta: number }) {
  if (delta === 0) {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
        style={{
          background: "var(--zoca-bg-soft)",
          color: "var(--zoca-text-2)",
          border: "1px solid var(--zoca-border)",
        }}
      >
        ± 0 needs call
      </span>
    );
  }
  const worse = delta > 0;
  const style: React.CSSProperties = worse
    ? {
        background: "rgba(124, 45, 18, 0.12)",
        color: "var(--zoca-pink-bright)",
        border: "1px solid rgba(200, 67, 29, 0.22)",
      }
    : {
        background: "rgba(16,185,129,0.08)",
        color: "#047857",
        border: "1px solid rgba(16,185,129,0.22)",
      };
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums"
      style={style}
      title={`${worse ? "+" : ""}${delta} needs call vs comparison`}
    >
      {worse ? "▲" : "▼"} {Math.abs(delta)} needs call
    </span>
  );
}
