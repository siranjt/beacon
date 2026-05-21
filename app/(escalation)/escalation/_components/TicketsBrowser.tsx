"use client";

import { useEffect, useMemo, useState } from "react";

interface Ticket {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: string;
  classification: string;
  category: string;
  churnPotentialStatus: string;
  createdAt: string;
  startedAt: string;
  completedAt: string;
  cancelledAt: string;
  entityId: string;
  customerName: string;
  customerId: string;
  amName: string;
  aeName: string;
  creatorEmail: string;
  assigneeEmail: string;
}

interface ApiResponse {
  ok: boolean;
  tickets?: Ticket[];
  stats?: {
    total: number;
    byClassification: Record<string, number>;
    byState: Record<string, number>;
  };
  sortedBy?: string;
  error?: string;
}

const CLASSIFICATIONS: { key: string; label: string; cls: string }[] = [
  { key: "Churn Ticket", label: "Churn", cls: "bg-err/15 text-err border-err/40" },
  { key: "Retention Risk Alert", label: "Retention Risk", cls: "bg-warn/15 text-warn border-warn/40" },
  { key: "Subscription Support Ticket", label: "Subscription Support", cls: "bg-accent/15 text-accent border-accent/40" },
  { key: "paid_user_offboarding", label: "Paid Offboarding", cls: "bg-purple-500/15 text-purple-300 border-purple-500/40" },
  { key: "Subscription_Cancellation", label: "Subscription Cancel", cls: "bg-pink-500/15 text-pink-300 border-pink-500/40" },
];

const STATES: { key: string; cls: string }[] = [
  { key: "Todo", cls: "bg-panel2 text-text border-border" },
  { key: "In Progress", cls: "bg-accent/15 text-accent border-accent/40" },
  { key: "In Review", cls: "bg-accent/15 text-accent border-accent/40" },
  { key: "Done", cls: "bg-ok/15 text-ok border-ok/40" },
  { key: "Canceled", cls: "bg-err/15 text-err border-err/40" },
  { key: "Duplicate", cls: "bg-err/15 text-err border-err/40" },
];

const TIME_WINDOWS = [
  { key: "0", label: "All time" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
  { key: "365", label: "1 year" },
];

function relTime(iso: string): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "";
  const sec = Math.floor((Date.now() - d) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export default function TicketsBrowser() {
  const [classFilter, setClassFilter] = useState<Set<string>>(
    new Set(CLASSIFICATIONS.map((c) => c.key))
  );
  const [stateFilter, setStateFilter] = useState<Set<string>>(
    new Set(["Todo", "In Progress", "In Review"])
  );
  const [sinceDays, setSinceDays] = useState("90");
  const [textFilter, setTextFilter] = useState("");

  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);

  async function load() {
    setLoading(true);
    try {
      const url = new URL("/escalation/api/tickets", window.location.origin);
      if (classFilter.size && classFilter.size < CLASSIFICATIONS.length) {
        url.searchParams.set("classifications", Array.from(classFilter).join(","));
      }
      if (sinceDays !== "0") url.searchParams.set("sinceDays", sinceDays);
      url.searchParams.set("limit", "300");
      const res = await fetch(url.toString());
      const text = await res.text();
      try {
        setResponse(JSON.parse(text));
      } catch {
        setResponse({ ok: false, error: "Non-JSON response (likely a timeout)" });
      }
    } catch (err: any) {
      setResponse({ ok: false, error: err?.message || "Network error" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinceDays]);

  const filtered = useMemo(() => {
    if (!response?.tickets) return [];
    const t = textFilter.trim().toLowerCase();
    return response.tickets.filter((tk) => {
      if (classFilter.size && !classFilter.has(tk.classification)) return false;
      if (stateFilter.size && !stateFilter.has(tk.state)) return false;
      if (t) {
        const blob = `${tk.identifier} ${tk.title} ${tk.customerName} ${tk.amName} ${tk.assigneeEmail}`.toLowerCase();
        if (!blob.includes(t)) return false;
      }
      return true;
    });
  }, [response, classFilter, stateFilter, textFilter]);

  function toggleClass(c: string) {
    setClassFilter((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }
  function toggleState(s: string) {
    setStateFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border bg-panel p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <p className="text-muted text-sm">Classification</p>
          <div className="flex items-center gap-3">
            <select
              className="rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
              value={sinceDays}
              onChange={(e) => setSinceDays(e.target.value)}
              title="Time window (createdAt)"
            >
              {TIME_WINDOWS.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="rounded-lg bg-accent text-white px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {CLASSIFICATIONS.map((c) => {
            const on = classFilter.has(c.key);
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggleClass(c.key)}
                className={`rounded-full border px-3 py-1 ${
                  on ? c.cls : "border-border text-muted bg-panel2"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        <div>
          <p className="text-muted text-sm mb-2">State</p>
          <div className="flex flex-wrap gap-2 text-xs">
            {STATES.map((s) => {
              const on = stateFilter.has(s.key);
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => toggleState(s.key)}
                  className={`rounded-full border px-3 py-1 ${
                    on ? s.cls : "border-border text-muted bg-panel2"
                  }`}
                >
                  {s.key}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <p className="text-muted text-sm mb-2">Search (identifier / title / customer / AM / assignee)</p>
          <input
            className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 outline-none focus:border-accent"
            placeholder="FIN-3901, churn, lacquer, asmita…"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
          />
        </div>
      </div>

      {loading && !response && (
        <div className="rounded-2xl border border-border bg-panel p-6 text-muted">
          Loading tickets from Metabase…
        </div>
      )}

      {response && response.ok === false && (
        <div className="rounded-2xl border border-err/40 bg-err/10 p-6">
          <p className="text-err font-medium">Error</p>
          <p className="text-sm mt-2 whitespace-pre-wrap">{response.error}</p>
        </div>
      )}

      {response && response.ok && response.tickets && (
        <>
          {response.stats && (
            <div className="rounded-2xl border border-border bg-panel p-4">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="text-muted mr-2">
                  {filtered.length} / {response.stats.total} tickets · sorted latest first
                </span>
                {CLASSIFICATIONS.map((c) => {
                  const n = response.stats!.byClassification[c.key] || 0;
                  return (
                    <span
                      key={c.key}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${c.cls}`}
                    >
                      {c.label} <span className="font-semibold">{n}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-border bg-panel p-2">
            {filtered.length === 0 ? (
              <p className="p-6 text-muted text-sm">
                No tickets match these filters. Widen the time window, enable more states, or clear search.
              </p>
            ) : (
              <ul>
                {filtered.map((t) => {
                  const sMeta = STATES.find((s) => s.key === t.state);
                  const cMeta = CLASSIFICATIONS.find((c) => c.key === t.classification);
                  return (
                    <li
                      key={t.id}
                      className="border-b border-border last:border-b-0 px-4 py-3 hover:bg-panel2/50"
                    >
                      <div className="flex items-baseline gap-2 text-xs flex-wrap">
                        <span className="font-mono text-muted">{t.identifier || "—"}</span>
                        <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 ${sMeta?.cls || "border-border text-muted"}`}>
                          {t.state}
                        </span>
                        {cMeta && (
                          <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 ${cMeta.cls}`}>
                            {cMeta.label}
                          </span>
                        )}
                        {t.churnPotentialStatus && (
                          <span className="inline-flex items-center rounded-md border border-warn/40 bg-warn/10 text-warn px-1.5 py-0.5">
                            {t.churnPotentialStatus}
                          </span>
                        )}
                        <span className="ml-auto text-muted" title={t.createdAt}>
                          {relTime(t.createdAt)}
                        </span>
                      </div>

                      <div className="mt-1.5">
                        <a
                          href={t.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm font-medium hover:underline underline-offset-4"
                        >
                          {t.title}
                        </a>
                      </div>

                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                        {t.customerName && (
                          <span>
                            <span className="text-muted">Customer</span>{" "}
                            <span className="text-text">{t.customerName}</span>
                          </span>
                        )}
                        {t.amName && (
                          <span>
                            <span className="text-muted">AM</span>{" "}
                            <span className="text-text">{t.amName}</span>
                          </span>
                        )}
                        {t.assigneeEmail && (
                          <span>
                            <span className="text-muted">Assignee</span>{" "}
                            <span className="text-text">{t.assigneeEmail}</span>
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
