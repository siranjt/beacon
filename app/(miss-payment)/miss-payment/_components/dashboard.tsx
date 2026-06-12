"use client";

/**
 * Miss Payment Beacon — main dashboard client component.
 *
 * Mirrors the standalone Missed Invoice Tracker dashboard exactly:
 * NDJSON-streaming invoice fetch (partial → complete), in-memory
 * annotations cache merged with optimistic UI on save, tab+KPI+filter
 * intersection, Excel export.
 *
 * Auth happens upstream (page.tsx server component checks role). This
 * client component assumes it's already inside an admin/manager session.
 */

import { useEffect, useMemo, useState } from "react";
import type { InvoiceRow, AnnotationsMap } from "@/lib/miss-payment/types";
import KpiCards, { type KpiKey } from "./kpi-cards";
import Charts from "./charts";
import Filters, { type FilterState } from "./filters";
import InvoicesTable from "./invoices-table";
import ExportButton from "./export-button";
import { RefreshCw } from "lucide-react";

type Tab = "All" | "June" | "May" | "April" | "March";
const TABS: Tab[] = ["All", "June", "May", "April", "March"];

const KPI_LABELS: Record<KpiKey, string> = {
  outstanding: "High-value (≥ $500)",
  invoices: "Repeat businesses (≥ 2 invoices)",
  ach: "ACH In Progress",
  multi: "Multi-month only",
  tickets: "Has Linear ticket",
  annotations: "Has notes",
};

// 2026-06-12 — Outstanding KPI filter threshold.
const HIGH_VALUE_THRESHOLD = 500;

export default function Dashboard() {
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationsMap>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("All");
  const [activeKpi, setActiveKpi] = useState<KpiKey | null>(null);
  const [filters, setFilters] = useState<FilterState>({
    q: "",
    am: "",
    status: "",
    month: "",
    ach: "",
    autoDebit: "",
    multiOnly: false,
  });

  async function loadInvoices(refresh = false) {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/miss-payment/api/invoices${refresh ? "?refresh=1" : ""}`);
      if (!r.ok) {
        let errMsg = `HTTP ${r.status}`;
        try {
          const txt = await r.text();
          try { const j = JSON.parse(txt); errMsg = j?.error || errMsg; }
          catch { errMsg = txt.slice(0, 200) || errMsg; }
        } catch {}
        throw new Error(errMsg);
      }

      const ct = r.headers.get("content-type") || "";

      if (ct.includes("ndjson") || ct.includes("text/plain")) {
        if (!r.body) throw new Error("Empty response body");
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let gotAnyRows = false;

        const handleLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let msg: any;
          try { msg = JSON.parse(trimmed); } catch { return; }
          if (msg.type === "error") throw new Error(msg.error || "Server error");
          if (msg.type === "partial" || msg.type === "complete") {
            if (Array.isArray(msg.rows)) { setRows(msg.rows); gotAnyRows = true; }
            if (msg.fetchedAt) setFetchedAt(msg.fetchedAt);
            setLoading(false);
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            handleLine(line);
          }
        }
        if (buffer.trim()) handleLine(buffer);
        if (!gotAnyRows) throw new Error("Stream ended with no rows");
      } else {
        const data = await r.json();
        if (data?.error) throw new Error(data.error);
        setRows(data.rows || []);
        setFetchedAt(data.fetchedAt || null);
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function loadAnnotations() {
    try {
      const r = await fetch("/miss-payment/api/annotations");
      const data = await r.json();
      setAnnotations(data.annotations || {});
    } catch {}
  }

  useEffect(() => {
    loadInvoices();
    loadAnnotations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const multiMonthSet = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of rows) {
      const key = r.entityId || r.customerId;
      if (!key) continue;
      if (!m.has(key)) m.set(key, new Set());
      if (r.invoiceMonth) m.get(key)!.add(r.invoiceMonth);
    }
    const out = new Set<string>();
    for (const [k, s] of m) if (s.size >= 2) out.add(k);
    return out;
  }, [rows]);

  const tabFiltered = useMemo(() => {
    if (activeTab === "All") return rows;
    return rows.filter((r) => r.invoiceMonth === activeTab);
  }, [rows, activeTab]);

  const annotationHasNotes = (inv: string) => {
    const a = annotations[inv];
    return !!(a && (a.caller || a.connectionStatus || a.comments || a.oldComments || a.amComment));
  };

  // 2026-06-12 — userFiltered applies the top filter row (search + AMs +
  // statuses + months + ACH + auto-debit + multi-only) but NOT the active KPI
  // filter. KpiCards counts off this set so the cards respond to top-row
  // filter changes (pick an AM → counts update) without double-counting the
  // KPI predicate (clicking Outstanding shouldn't shrink the Outstanding
  // total below the actual filtered-row count).
  const userFiltered = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return tabFiltered.filter((r) => {
      if (q) {
        const blob = `${r.bizName} ${r.amName} ${r.customerId} ${r.invoiceNumber} ${r.customerEmail} ${r.customerCompany}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      if (filters.am && r.amName !== filters.am) return false;
      if (filters.status && r.status !== filters.status) return false;
      if (filters.month && r.invoiceMonth !== filters.month) return false;
      if (filters.ach === "in_progress" && r.achStatus !== "In Progress") return false;
      if (filters.ach === "none" && r.achStatus) return false;
      if (filters.autoDebit && r.autoDebit !== filters.autoDebit) return false;
      if (filters.multiOnly) {
        const key = r.entityId || r.customerId;
        if (!multiMonthSet.has(key)) return false;
      }
      return true;
    });
  }, [tabFiltered, filters, multiMonthSet]);

  // Repeat-business set must be computed on userFiltered so the "invoices"
  // KPI's "N from repeat businesses" count matches what the cards show.
  const repeatBusinessSet = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of userFiltered) {
      counts.set(r.customerId, (counts.get(r.customerId) || 0) + 1);
    }
    const out = new Set<string>();
    for (const [cid, n] of counts) if (n >= 2) out.add(cid);
    return out;
  }, [userFiltered]);

  const filtered = useMemo(() => {
    return userFiltered.filter((r) => {
      // Outstanding card filter: only high-value invoices.
      if (activeKpi === "outstanding" && (r.amountDue || 0) < HIGH_VALUE_THRESHOLD) return false;
      // Invoices card filter: only rows from repeat businesses.
      if (activeKpi === "invoices" && !repeatBusinessSet.has(r.customerId)) return false;
      if (activeKpi === "ach" && r.achStatus !== "In Progress") return false;
      if (activeKpi === "multi") {
        const key = r.entityId || r.customerId;
        if (!multiMonthSet.has(key)) return false;
      }
      if (activeKpi === "tickets" && !r.latestTicket) return false;
      if (activeKpi === "annotations" && !annotationHasNotes(r.invoiceNumber)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userFiltered, multiMonthSet, activeKpi, annotations, repeatBusinessSet]);

  const tabCounts = useMemo(() => {
    const m: Record<Tab, number> = { All: rows.length, June: 0, May: 0, April: 0, March: 0 };
    for (const r of rows) {
      if (r.invoiceMonth === "June") m.June++;
      else if (r.invoiceMonth === "May") m.May++;
      else if (r.invoiceMonth === "April") m.April++;
      else if (r.invoiceMonth === "March") m.March++;
    }
    return m;
  }, [rows]);

  async function saveAnnotation(invoiceNumber: string, patch: any) {
    setAnnotations((prev) => ({
      ...prev,
      [invoiceNumber]: { ...(prev[invoiceNumber] || {}), ...patch },
    }));
    try {
      await fetch("/miss-payment/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceNumber, patch }),
      });
    } catch {}
  }

  function onKpiClick(k: KpiKey) {
    // 2026-06-12 — every KPI now toggles a real filter, including outstanding
    // and invoices. Click again to clear (cur === k → null).
    setActiveKpi((cur) => (cur === k ? null : k));
  }

  const lastFetchLabel = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  return (
    <div className="miss-payment-scope">
      <div className="space-y-5">
        {error && (
          <div
            className="surface text-sm"
            style={{ padding: 14, background: "#F5C9B6", borderColor: "#C8431D", color: "#7C2D12" }}
          >
            {error}
          </div>
        )}

        <Filters value={filters} onChange={setFilters} rows={rows} />

        {/* Status row */}
        <div className="flex items-center justify-between flex-wrap gap-3 px-1">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] text-zoca-textMuted">
            <span>
              Showing{" "}
              <span style={{ color: "#4A7C59" }} className="font-bold normal-case">{filtered.length}</span>
              {" "}/ {rows.length}
            </span>
            {lastFetchLabel && (
              <>
                <span className="text-zoca-strokeStrong">·</span>
                <span>
                  Last refresh{" "}
                  <span className="text-zoca-text font-semibold normal-case">{lastFetchLabel}</span>
                </span>
              </>
            )}
            {activeKpi && activeKpi !== "outstanding" && activeKpi !== "invoices" && (
              <>
                <span className="text-zoca-strokeStrong">·</span>
                <span className="filter-chip">
                  {KPI_LABELS[activeKpi]}
                  <button onClick={() => setActiveKpi(null)} aria-label="Clear filter">×</button>
                </span>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <ExportButton rows={filtered} annotations={annotations} multiMonthSet={multiMonthSet} />
            <button onClick={() => loadInvoices(true)} disabled={refreshing} className="btn-zoca">
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
              Refresh live data
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div role="tablist" className="surface !rounded-full !p-1.5 inline-flex gap-1 flex-wrap w-fit">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={activeTab === t}
              onClick={() => setActiveTab(t)}
              className="tab-pill"
            >
              {t} <span className="opacity-70 ml-1 text-[11px]">({tabCounts[t]})</span>
            </button>
          ))}
        </div>

        <KpiCards
          rows={userFiltered}
          multiMonthSet={multiMonthSet}
          annotations={annotations}
          activeKpi={activeKpi}
          onKpiClick={onKpiClick}
        />
        <Charts rows={filtered} />
        <InvoicesTable
          rows={filtered}
          annotations={annotations}
          onSave={saveAnnotation}
          loading={loading}
          multiMonthSet={multiMonthSet}
        />
      </div>
    </div>
  );
}
