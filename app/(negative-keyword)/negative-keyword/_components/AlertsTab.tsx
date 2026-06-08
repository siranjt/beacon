"use client";

/**
 * Negative Keyword Beacon — Alerts tab. Phase NK-4.3.
 *
 * The primary surface AMs work from. Listed alerts, filter chips, per-row
 * Create Ticket / Dismiss actions, pagination.
 *
 * Filtering is client-side (Dashboard owns the filter state and passes a
 * pre-filtered slice in). This component just renders + handles row
 * actions. After any row action (ticket created / dismissed), it asks
 * the parent to re-fetch by calling onAlertChanged().
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

function fmtDateTime(date: string | null | undefined, time: string | null): string {
  if (!date) return "—";
  // Postgres DATE may come back as "YYYY-MM-DD" OR as a full ISO timestamp
  // depending on neon driver type metadata. Same with TIME for the time
  // column. Normalize both before composing a Date.
  const dateStr = String(date).slice(0, 10);
  const timeStr = time ? String(time).slice(0, 8) : "00:00:00";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return String(date);
  const d = new Date(`${dateStr}T${timeStr}`);
  if (!Number.isFinite(d.getTime())) return dateStr;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusFor(a: AlertItem): { label: string; tone: string } {
  if (a.ticket_id) return { label: "Ticketed", tone: "nk-pill-brass" };
  if (a.dismissed_at) return { label: "Dismissed", tone: "nk-pill-smoke" };
  return { label: "Open", tone: "nk-pill-ember" };
}

export default function AlertsTab({
  alerts,
  totalAlerts,
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
    if (reason === null) return; // cancelled
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

  return (
    <div className="nk-alerts-tab">
      {/* Filter row */}
      <div className="nk-filter-row">
        <FilterGroup
          label="Status"
          value={filter.status}
          options={[
            { value: "open", label: "Open" },
            { value: "ticketed", label: "Ticketed" },
            { value: "dismissed", label: "Dismissed" },
            { value: "all", label: "All" },
          ]}
          onChange={(v) =>
            onFilterChange({ ...filter, status: v as AlertsFilter["status"] })
          }
        />
        <FilterGroup
          label="Source"
          value={filter.source || ""}
          options={[
            { value: "", label: "All sources" },
            ...ALERT_SOURCES.map((s) => ({ value: s, label: s })),
          ]}
          onChange={(v) =>
            onFilterChange({ ...filter, source: v as AlertSource | "" })
          }
        />
        <FilterGroup
          label="Category"
          value={filter.category || ""}
          options={[
            { value: "", label: "All categories" },
            ...RISK_CATEGORIES.map((c) => ({ value: c, label: c })),
          ]}
          onChange={(v) =>
            onFilterChange({ ...filter, category: v as RiskCategory | "" })
          }
        />

        <div className="nk-filter-summary">
          Showing {alerts.length} of {totalAlerts}
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
              <thead>
                <tr>
                  <th>Business</th>
                  <th>AM</th>
                  <th>Source</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>When</th>
                  <th>Analysis</th>
                  <th className="nk-actions-col">Actions</th>
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
                      <td>
                        <div className="nk-biz">{a.business_name}</div>
                        <div className="nk-eid">{a.entity_id.slice(0, 8)}</div>
                      </td>
                      <td>{a.am_name ?? <span className="nk-muted">unassigned</span>}</td>
                      <td>
                        <span className="nk-pill nk-pill-source">{a.source}</span>
                      </td>
                      <td>
                        <span className={`nk-pill ${CATEGORY_TONE[a.risk_category]}`}>
                          {a.risk_category}
                        </span>
                        {a.classifier === "ai" ? (
                          <span className="nk-classifier-mark" title="AI-classified">·AI</span>
                        ) : (
                          <span className="nk-classifier-mark" title="Regex fallback">·rgx</span>
                        )}
                      </td>
                      <td>
                        <span className={`nk-pill ${st.tone}`}>{st.label}</span>
                      </td>
                      <td className="nk-when">{fmtDateTime(a.message_date, a.message_time)}</td>
                      <td className="nk-analysis">{a.analysis}</td>
                      <td className="nk-actions-col">
                        {isOpen ? (
                          <div className="nk-actions">
                            <button
                              type="button"
                              className="nk-btn nk-btn-primary"
                              disabled={busy}
                              onClick={() => void createTicket(a)}
                            >
                              {busy ? "…" : "Create ticket"}
                            </button>
                            <button
                              type="button"
                              className="nk-btn nk-btn-ghost"
                              disabled={busy}
                              onClick={() => void dismiss(a)}
                            >
                              Dismiss
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
                          <span className="nk-muted">{a.dismissed_reason ?? "—"}</span>
                        )}
                        {msg && <div className="nk-row-msg">{msg}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
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

function FilterGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="nk-filter-group">
      <div className="nk-filter-label">{label}</div>
      <div className="nk-filter-chips">
        {options.map((o) => (
          <button
            key={o.value || "_all"}
            type="button"
            className={`nk-chip ${value === o.value ? "is-active" : ""}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
