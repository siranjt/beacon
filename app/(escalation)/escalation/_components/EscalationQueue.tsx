"use client";

import { useEffect, useMemo, useState } from "react";
import { CLASSIFICATION_COLORS, CLASSIFICATION_LABELS } from "./charts/colors";

interface QueueEntry {
  entityId: string;
  customerId: string;
  customerName: string;
  amName: string;
  aeName: string;
  score: number;
  reasons: string[];
  openTickets: number;
  totalTickets: number;
  latestTicket?: {
    identifier: string;
    title: string;
    classification: string;
    state: string;
    url: string;
    createdAt: string;
  };
  lastActivityAt: string;
  hasChurnTicket: boolean;
  hasRetentionRiskTicket: boolean;
  hasCancellationTicket: boolean;
}

interface ApiResponse {
  ok: boolean;
  total?: number;
  shown?: number;
  byTier?: Record<string, number>;
  ams?: { name: string; count: number }[];
  entries?: QueueEntry[];
  error?: string;
}

const TIERS: { key: string; label: string; cls: string }[] = [
  { key: "critical", label: "Critical", cls: "bg-errSoft text-err border-err/30" },
  { key: "high", label: "High", cls: "bg-warnSoft text-warn border-warn/30" },
  { key: "medium", label: "Medium", cls: "bg-cobaltSoft text-cobalt border-cobalt/30" },
  { key: "watch", label: "Watch", cls: "bg-panel2 text-muted2 border-border" },
];

function tierFor(score: number): { label: string; cls: string } {
  if (score >= 50) return TIERS[0];
  if (score >= 30) return TIERS[1];
  if (score >= 15) return TIERS[2];
  return TIERS[3];
}

function relTime(iso: string): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "";
  const sec = Math.floor((Date.now() - d) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

export default function EscalationQueue() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tierFilter, setTierFilter] = useState<Set<string>>(
    new Set(["critical", "high"])
  );
  const [amFilter, setAmFilter] = useState<string>("");
  const [searchFilter, setSearchFilter] = useState<string>("");

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/escalation/api/queue?limit=200");
      const json = (await res.json()) as ApiResponse;
      setData(json);
    } catch (err: any) {
      setData({ ok: false, error: err?.message || "Network error" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    if (!data?.entries) return [];
    const q = searchFilter.trim().toLowerCase();
    return data.entries.filter((e) => {
      if (tierFilter.size > 0 && !tierFilter.has(tierFor(e.score).label.toLowerCase()))
        return false;
      if (amFilter && e.amName !== amFilter) return false;
      if (q) {
        const hay = `${e.customerName} ${e.amName} ${e.entityId} ${e.latestTicket?.identifier || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, tierFilter, amFilter, searchFilter]);

  function toggleTier(t: string) {
    setTierFilter((prev) => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  }

  return (
    <div className="space-y-6">
      <section className="text-center pt-2">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-cobalt/20 bg-cobaltSoft text-xs font-semibold uppercase tracking-wider text-cobalt">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-cobalt live-dot" />
          Live · scored from Metabase tickets feed
        </div>
        <h1 className="mt-5 font-extrabold text-[44px] leading-[1.0] tracking-[-0.04em] text-text">
          Escalation <span className="brand-gradient-text">Queue</span>
        </h1>
        <p className="mt-4 max-w-[600px] mx-auto text-[14px] text-muted2 leading-[1.65]">
          Customers ranked by an open-ticket and churn-signal score. Higher = handle sooner.
          Click any row to drop into Customer 360.
        </p>
      </section>

      {/* Tier summary + filters */}
      <section className="rounded-2xl border border-border bg-panel p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted">Tier</span>
          {TIERS.map((t) => {
            const on = tierFilter.has(t.key);
            const count = data?.byTier?.[t.label] || 0;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => toggleTier(t.key)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  on ? t.cls : "border-border text-muted2 bg-panel2"
                }`}
              >
                {t.label} <span className="font-semibold ml-1">{count}</span>
              </button>
            );
          })}

          <span className="ml-3 text-[10px] uppercase tracking-wider font-bold text-muted">AM</span>
          <select
            value={amFilter}
            onChange={(e) => setAmFilter(e.target.value)}
            className="bg-panel2 border border-border rounded-full px-3 py-1 text-xs outline-none focus:border-cobalt"
          >
            <option value="">All AMs</option>
            {data?.ams?.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name} ({a.count})
              </option>
            ))}
          </select>

          <input
            className="ml-auto bg-panel2 border border-border rounded-full px-3 py-1.5 outline-none focus:border-cobalt text-xs w-64"
            placeholder="Search customer or ticket id…"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
        </div>
      </section>

      {/* List */}
      {loading && (
        <div className="rounded-2xl border border-border bg-panel p-8 text-sm text-muted2">
          Scoring all customers from the Metabase tickets feed…
        </div>
      )}
      {data && data.ok === false && (
        <div className="rounded-2xl border border-err/30 bg-errSoft p-5 text-sm">
          <p className="text-err font-semibold">Queue unavailable</p>
          <p className="text-muted2 mt-1">{data.error}</p>
        </div>
      )}
      {data?.ok && (
        <section className="rounded-2xl border border-border bg-panel overflow-hidden">
          <div className="px-5 py-3 border-b border-border text-xs text-muted2 flex items-center justify-between">
            <span>
              {filtered.length} of {data.entries?.length || 0} customers · sorted highest score first
            </span>
            <span>Rule-based · open ticket weights + recency + churn potential</span>
          </div>

          {filtered.length === 0 ? (
            <div className="p-8 text-sm text-muted2">No customers match these filters.</div>
          ) : (
            <ul>
              {filtered.map((e) => {
                const tier = tierFor(e.score);
                const cls = e.latestTicket
                  ? CLASSIFICATION_COLORS[e.latestTicket.classification] || "#838d9d"
                  : "#838d9d";
                const classLabel = e.latestTicket
                  ? CLASSIFICATION_LABELS[e.latestTicket.classification] || e.latestTicket.classification
                  : "";
                const drillUrl = `/?q=${encodeURIComponent(e.entityId)}`;
                return (
                  <li
                    key={e.entityId}
                    className="severity-bar row-divider row-hover px-5 py-4 cursor-pointer"
                    style={{ ["--bar" as any]: cls }}
                    onClick={() => {
                      window.location.href = drillUrl;
                    }}
                  >
                    <div className="flex items-start gap-5">
                      {/* Score */}
                      <div className="text-center shrink-0 w-[58px]">
                        <div
                          className={`text-[26px] font-extrabold tracking-tight leading-none ${tier.cls.split(" ")[1]}`}
                          style={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {e.score}
                        </div>
                        <div
                          className={`text-[10px] mt-1 px-2 py-0.5 rounded-full border inline-block ${tier.cls}`}
                        >
                          {tier.label}
                        </div>
                      </div>

                      {/* Center body */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="text-[16px] font-semibold tracking-tight truncate">
                            {e.customerName}
                          </span>
                          {e.amName && (
                            <span className="text-xs text-muted">
                              AM <span className="text-text font-medium">{e.amName}</span>
                            </span>
                          )}
                        </div>

                        {e.latestTicket && (
                          <div className="text-xs mt-1.5 flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-muted">{e.latestTicket.identifier}</span>
                            {classLabel && (
                              <span
                                className="rounded-full border px-2 py-0.5 font-medium"
                                style={{ borderColor: cls + "55", background: cls + "10", color: cls }}
                              >
                                {classLabel}
                              </span>
                            )}
                            <span className="text-muted2">{e.latestTicket.state}</span>
                            <span className="text-text truncate max-w-[280px]">
                              {e.latestTicket.title}
                            </span>
                            <span className="text-muted ml-auto">{relTime(e.latestTicket.createdAt)} ago</span>
                          </div>
                        )}

                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {e.reasons.map((r, i) => (
                            <span
                              key={i}
                              className="text-[10px] rounded-full bg-panel2 text-muted2 border border-border px-2 py-0.5"
                            >
                              {r}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Right meta */}
                      <div className="text-right shrink-0 text-xs">
                        <div className="text-muted">
                          {e.openTickets} open · {e.totalTickets} total
                        </div>
                        <a
                          href={drillUrl}
                          onClick={(ev) => ev.stopPropagation()}
                          className="inline-block mt-2 text-cobalt hover:underline underline-offset-2 font-medium"
                        >
                          Drill in →
                        </a>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
