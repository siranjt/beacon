"use client";

/**
 * Negative Keyword Beacon — 3-tab dashboard. Phase NK-4.1.
 *
 * Tabs:
 *   - Overview   — KPI cards + 3 charts derived from the alerts list
 *   - Alerts     — paginated table + filters + Create Ticket / Dismiss actions
 *   - Tickets    — read-only list of open Linear retention-risk tickets
 *
 * The dashboard hydrates alerts ONCE on tab=overview/alerts entry; both
 * tabs share the same array (Overview derives charts client-side). The
 * Tickets tab hits a different endpoint and isn't loaded until clicked.
 *
 * Filter state lives in component state, NOT URL params — switching tabs
 * preserves filters in memory, but a hard refresh resets them. Tab
 * choice IS URL-persisted via `?tab=` so refreshes stay on the same tab.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import OverviewTab from "./OverviewTab";
import AlertsTab from "./AlertsTab";
import TicketsTab from "./TicketsTab";
import type {
  AlertItem,
  AlertSource,
  RiskCategory,
} from "@/lib/negative-keyword/types";

type Tab = "overview" | "alerts" | "tickets";

export interface AlertsFilter {
  status: "all" | "open" | "ticketed" | "dismissed";
  source: AlertSource | "";
  category: RiskCategory | "";
}

const DEFAULT_FILTER: AlertsFilter = {
  status: "open",
  source: "",
  category: "",
};

function initialTab(): Tab {
  if (typeof window === "undefined") return "overview";
  const p = new URLSearchParams(window.location.search);
  const t = p.get("tab");
  if (t === "alerts" || t === "tickets" || t === "overview") return t;
  return "overview";
}

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [filter, setFilter] = useState<AlertsFilter>(DEFAULT_FILTER);

  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [alertsFetchedAt, setAlertsFetchedAt] = useState<string | null>(null);
  const [scope, setScope] = useState<"am" | "all">("all");

  /** Reflect tab state into the URL without reloading. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (tab === "overview") u.searchParams.delete("tab");
    else u.searchParams.set("tab", tab);
    window.history.replaceState({}, "", u);
  }, [tab]);

  /** Fetch alerts once on mount + on explicit refresh. Filters are
   *  applied CLIENT-SIDE on the returned array so we don't hit the
   *  server every time the user toggles a chip. */
  const fetchAlerts = useCallback(async () => {
    setAlertsLoading(true);
    setAlertsError(null);
    try {
      const res = await fetch("/negative-keyword/api/alerts?limit=1000", {
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      setAlerts(data.alerts || []);
      setAlertsFetchedAt(data.fetchedAt || new Date().toISOString());
      setScope(data.scope || "all");
    } catch (e) {
      setAlertsError(e instanceof Error ? e.message : String(e));
    } finally {
      setAlertsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAlerts();
  }, [fetchAlerts]);

  /** Client-side filter pipeline shared by Overview KPIs + Alerts table. */
  const filteredAlerts = useMemo(() => {
    return alerts.filter((a) => {
      if (filter.status === "open") {
        if (a.ticket_id || a.dismissed_at) return false;
      } else if (filter.status === "ticketed") {
        if (!a.ticket_id) return false;
      } else if (filter.status === "dismissed") {
        if (!a.dismissed_at) return false;
      }
      if (filter.source && a.source !== filter.source) return false;
      if (filter.category && a.risk_category !== filter.category) return false;
      return true;
    });
  }, [alerts, filter]);

  return (
    <div>
      {/* Tab bar */}
      <div className="nk-tabs" role="tablist" aria-label="Negative Keyword Beacon tabs">
        {(
          [
            { id: "overview" as const, label: "Overview" },
            { id: "alerts" as const, label: "Alerts" },
            { id: "tickets" as const, label: "Created Tickets" },
          ]
        ).map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`nk-tab ${tab === t.id ? "is-active" : ""}`}
            onClick={() => setTab(t.id)}
            type="button"
          >
            {t.label}
          </button>
        ))}

        <div className="nk-tab-meta">
          {alertsFetchedAt && (
            <span className="nk-tab-meta-stamp">
              {alerts.length} alerts · {scope === "am" ? "your book" : "all customers"} · refreshed{" "}
              {new Date(alertsFetchedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
          <button
            type="button"
            className="nk-refresh"
            onClick={() => void fetchAlerts()}
            disabled={alertsLoading}
            aria-label="Refresh alerts"
          >
            {alertsLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Tab content */}
      {alertsError && (
        <div className="nk-error" role="alert">
          Could not load alerts: {alertsError}
        </div>
      )}

      {tab === "overview" && (
        <OverviewTab
          alerts={alerts}
          loading={alertsLoading}
          onJumpTo={(seed) => {
            // From an overview chart click, jump into Alerts with that chip preset.
            setFilter((prev) => ({ ...prev, ...seed }));
            setTab("alerts");
          }}
        />
      )}

      {tab === "alerts" && (
        <AlertsTab
          alerts={filteredAlerts}
          totalAlerts={alerts.length}
          loading={alertsLoading}
          filter={filter}
          onFilterChange={setFilter}
          onAlertChanged={() => void fetchAlerts()}
        />
      )}

      {tab === "tickets" && <TicketsTab />}
    </div>
  );
}
