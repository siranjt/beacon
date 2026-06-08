"use client";

/**
 * Negative Keyword Beacon — Alerts tab. Phase NK-4 (polish rev).
 *
 * Column layout (matches the standalone repo's original dashboard):
 *   DATE · SOURCE · ENTITY ID · BUSINESS NAME · AM NAME · CATEGORY ·
 *   SUBJECT · MESSAGE · ANALYSIS · TICKET
 *
 * Filter row gained: search input, AM dropdown, From/To date pickers,
 * and a CSV download button — also from the standalone repo.
 *
 * Filtering is client-side. Dashboard owns the AlertsFilter state and
 * applies the combined filter before passing alerts in. This component
 * renders + handles row actions + emits filter changes.
 */

import { useMemo, useState } from "react";
import type { AlertItem } from "@/lib/negative-keyword/types";
import {
  ALERT_SOURCES,
  RISK_CATEGORIES,
  type AlertSource,
  type RiskCategory,
} from "@/lib/negative-keyword/types";
import type { AlertsFilter } from "./Dashboard";

interface Props {
  alerts: AlertItem[];
  totalAlerts: number;
  amOptions: string[];
  loading: boolean;
  filter: AlertsFilter;
  onFilterChange: (next: AlertsFilter) => void;
  onAlertChanged: () => void;
}

const PAGE_SIZE = 25;

const CATEGORY_TONE: Record<RiskCategory, string> = {
  Cancellation: "nk-pill-crimson",
  Billing: "nk-pill-brass",
  "Lead quality": "nk-pill-ember",
  Technical: "nk-pill-lapis",
  Disappointed: "nk-pill-patina",
  Flagged: "nk-pill-smoke",
};

function fmtDate(date: string | null | undefined): string {
  if (!date) return "—";
  const dateStr = String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return String(date);
  const d = new Date(`${dateStr}T00:00:00`);
  if (!Number.isFinite(d.getTime())) return dateStr;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function shortEid(eid: string): string {
  if (!eid) return "—";
  return `${eid.slice(0, 8)}…`;
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "—";
  const cleaned = String(s).replace(/\s+/g, " ").trim();
  if (!cleaned) return "—";
  return cleaned.length > n ? `${cleaned.slice(0, n)}…` : cleaned;
}

function statusFor(a: AlertItem): { label: string; tone: string } {
  if (a.ticket_id) return { label: "Ticketed", tone: "nk-pill-brass" };
  if (a.dismissed_at) return { label: "Dismissed", tone: "nk-pill-smoke" };
  return { label: "Open", tone: "nk-pill-ember" };
}

/** Convert visible alerts to CSV. RFC-4180 escape: quote fields that
 *  contain commas / quotes / newlines, double internal quotes. */
function exportToCsv(rows: AlertItem[]): string {
  const headers = [
    "date",
    "source",
    "entity_id",
    "business_name",
    "am_name",
    "owning_am_email",
    "category",
    "classifier",
    "message",
    "analysis",
    "ticket_identifier",
    "ticket_url",
  ];
  const esc = (v: string | null | undefined) => {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const out = [headers.join(",")];
  for (const a of rows) {
    out.push(
      [
        String(a.message_date ?? "").slice(0, 10),
        a.source,
        a.entity_id,
        a.business_name,
        a.am_name ?? "",
        a.owning_am_email,
        a.risk_category,
        a.classifier,
        (a.message_body ?? "").replace(/\s+/g, " ").trim(),
        a.analysis,
        a.ticket_identifier ?? "",
        a.ticket_url ?? "",
      ]
        .map(esc)
        .join(","),
    );
  }
  return out.join("\n");
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AlertsTab({
  alerts,
  totalAlerts,
  amOptions,
  loading,
  filter,
  onFilterChange,
  onAlertChanged,
}: Props) {
  const [page, setPage] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<Record<string, string>>({});

  const pages = Math.max(1, Math.ceil(alerts.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const slice = useMemo(
    () => alerts.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [alerts, safePage],
  );

  async function createTicket(alert: AlertItem) {
    if (!alert.id) return;
    setBusyId(alert.id);
    setRowMessage((m) => ({ ...m, [alert.id!]: "" }));
    try {
      const res = await fetch("/negative-keyword/api/create-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alert_id: alert.id }),
      });
      const data = await res.json();
      if (data.ok && data.ticket) {
        setRowMessage((m) => ({
          ...m,
          [alert.id!]: `→ ${data.ticket.ticket_identifier}`,
        }));
      } else if (data.skipped && data.reason === "duplicate") {
        setRowMessage((m) => ({
          ...m,
          [alert.id!]: "Open ticket already exists in Linear",
        }));
      } else {
        setRowMessage((m) => ({
          ...m,
          [alert.id!]: data.error || "Create failed",
        }));
      }
      onAlertChanged();
    } catch (e) {
      setRowMessage((m) => ({
        ...m,
        [alert.id!]: e instanceof Error ? e.message : "Network error",
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(alert: AlertItem) {
    if (!alert.id) return;
    const reason = window.prompt(
      `Dismiss this ${alert.risk_category} alert for ${alert.business_name}?\n\nOptional reason:`,
      "",
    );
    if (reason === null) return;
    setBusyId(alert.id);
    setRowMessage((m) => ({ ...m, [alert.id!]: "" }));
    try {
      const res = await fetch("/negative-keyword/api/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alert_id: alert.id, reason }),
      });
      const data = await res.json();
      if (data.ok) {
        setRowMessage((m) => ({ ...m, [alert.id!]: "Dismissed" }));
        onAlertChanged();
      } else {
        setRowMessage((m) => ({
          ...m,
          [alert.id!]: data.error || "Dismiss failed",
        }));
      }
    } catch (e) {
      setRowMessage((m) => ({
        ...m,
        [alert.id!]: e instanceof Error ? e.message : "Network error",
      }));
    } finally {
      setBusyId(null);
    }
  }

  function handleCsv() {
    const csv = exportToCsv(alerts);
    const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    downloadCsv(csv, `negative-keyword-alerts-${ts}.csv`);
  }

  return (
    <div className="nk-alerts-tab">
      {/* Top filter bar — chips + search + AM + date range */}
      <div className="nk-filter-bar">
        <div className="nk-filter-line">
          <input
            type="text"
            value={filter.search}
            placeholder="Search business, sender, message…"
            onChange={(e) =>
              onFilterChange({ ...filter, search: e.target.value })
            }
            className="nk-input nk-search"
          />

          <select
            value={filter.category}
            onChange={(e) =>
              onFilterChange({
                ...filter,
                category: e.target.value as RiskCategory | "",
              })
            }
            className="nk-input nk-select"
          >
            <option value="">All categories</option>
            {RISK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            value={filter.am}
            onChange={(e) => onFilterChange({ ...filter, am: e.target.value })}
            className="nk-input nk-select"
          >
            <option value="">All AMs</option>
            {amOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>

          <select
            value={filter.source}
            onChange={(e) =>
              onFilterChange({
                ...filter,
                source: e.target.value as AlertSource | "",
              })
            }
            className="nk-input nk-select"
          >
            <option value="">All sources</option>
            {ALERT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <div className="nk-date-block">
            <span className="nk-date-label">From</span>
            <input
              type="date"
              value={filter.since}
              onChange={(e) =>
                onFilterChange({ ...filter, since: e.target.value })
              }
              className="nk-input nk-date"
            />
          </div>
          <div className="nk-date-block">
            <span className="nk-date-label">To</span>
            <input
              type="date"
              value={filter.until}
              onChange={(e) =>
                onFilterChange({ ...filter, until: e.target.value })
              }
              className="nk-input nk-date"
            />
          </div>
        </div>

        <div className="nk-filter-line nk-filter-line-2">
          <div className="nk-filter-chips">
            <span className="nk-filter-mini-label">Status:</span>
            {(
              [
                ["open", "Open"],
                ["ticketed", "Ticketed"],
                ["dismissed", "Dismissed"],
                ["all", "All"],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                className={`nk-chip ${filter.status === val ? "is-active" : ""}`}
                onClick={() =>
                  onFilterChange({
                    ...filter,
                    status: val,
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>

          <div className="nk-filter-summary">
            Showing <strong>{alerts.length}</strong> / {totalAlerts}
          </div>

          <button
            type="button"
            className="nk-btn nk-btn-ghost"
            onClick={handleCsv}
            disabled={alerts.length === 0}
            aria-label="Download visible alerts as CSV"
          >
            ↓ CSV
          </button>
        </div>
      </div>

      {/* Table */}
      {loading && alerts.length === 0 ? (
        <div className="nk-empty">Loading alerts…</div>
      ) : alerts.length === 0 ? (
        <div className="nk-empty">
          No alerts match the current filters.
          {filter.status !== "all" && (
            <>
              {" "}
              <button
                type="button"
                className="nk-link"
                onClick={() => onFilterChange({ ...filter, status: "all" })}
              >
                Show all statuses
              </button>
              .
            </>
          )}
        </div>
      ) : (
        <div className="surface nk-table-card">
          <div className="nk-table-wrap">
            <table className="nk-table">
              <colgroup>
                <col style={{ width: "70px" }} />
                <col style={{ width: "90px" }} />
                <col style={{ width: "110px" }} />
                <col style={{ width: "180px" }} />
                <col style={{ width: "120px" }} />
                <col style={{ width: "120px" }} />
                <col style={{ width: "300px" }} />
                <col style={{ width: "320px" }} />
                <col style={{ width: "130px" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Source</th>
                  <th>Entity ID</th>
                  <th>Business Name</th>
                  <th>AM Name</th>
                  <th>Category</th>
                  <th>Message</th>
                  <th>Analysis</th>
                  <th className="nk-actions-col">Ticket</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((a) => {
                  const st = statusFor(a);
                  const msg = rowMessage[a.id ?? ""];
                  const busy = busyId === a.id;
                  const isOpen = !a.ticket_id && !a.dismissed_at;
                  return (
                    <tr key={a.id ?? `${a.entity_id}-${a.dedup_key}`}>
                      <td className="nk-when">{fmtDate(a.message_date)}</td>
                      <td>
                        <span className="nk-pill nk-pill-source">{a.source}</span>
                      </td>
                      <td className="nk-mono nk-eid-cell" title={a.entity_id}>
                        {shortEid(a.entity_id)}
                      </td>
                      <td className="nk-biz">{a.business_name}</td>
                      <td>
                        {a.am_name ?? <span className="nk-muted">Unknown</span>}
                      </td>
                      <td>
                        <span className={`nk-pill ${CATEGORY_TONE[a.risk_category]}`}>
                          {a.risk_category}
                        </span>
                      </td>
                      <td title={a.message_body ?? undefined}>
                        <div className="nk-clamp">{truncate(a.message_body, 160)}</div>
                      </td>
                      <td title={a.analysis}>
                        <div className="nk-clamp">{truncate(a.analysis, 180)}</div>
                      </td>
                      <td className="nk-actions-col">
                        {isOpen ? (
                          <div className="nk-ticket-actions">
                            <button
                              type="button"
                              className="nk-btn nk-btn-primary"
                              disabled={busy}
                              onClick={() => void createTicket(a)}
                            >
                              {busy ? "…" : "Create"}
                            </button>
                            <button
                              type="button"
                              className="nk-x-btn"
                              disabled={busy}
                              onClick={() => void dismiss(a)}
                              aria-label="Dismiss this alert"
                              title="Dismiss alert"
                            >
                              ×
                            </button>
                          </div>
                        ) : a.ticket_id && a.ticket_url ? (
                          <a
                            href={a.ticket_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="nk-link"
                          >
                            {a.ticket_identifier || "Open ticket"}
                          </a>
                        ) : (
                          <span className="nk-muted nk-status-strip">
                            <span className={`nk-pill ${st.tone}`}>{st.label}</span>
                            {a.dismissed_reason && (
                              <span className="nk-muted-reason">
                                {a.dismissed_reason}
                              </span>
                            )}
                          </span>
                        )}
                        {msg && <div className="nk-row-msg">{msg}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="nk-pager">
              <button
                type="button"
                className="nk-btn nk-btn-ghost"
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                ‹ Prev
              </button>
              <span className="nk-pager-stamp">
                Page {safePage + 1} of {pages}
              </span>
              <button
                type="button"
                className="nk-btn nk-btn-ghost"
                disabled={safePage >= pages - 1}
                onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              >
                Next ›
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
