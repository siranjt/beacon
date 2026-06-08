"use client";

/**
 * Negative Keyword Beacon — 3-tab dashboard. Phase NK-4 (polish rev).
 *
 * Layout mirrors the original standalone Negative Keyword Alert
 * dashboard's structure (rich KPI breakdown, AM exposure chart,
 * full filter row) while staying in Beacon's Watchfire theme +
 * BeaconPageShell chrome.
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
  am: string; // AM name; "" = all
  search: string; // matches business_name / sender / message_body
  since: string; // YYYY-MM-DD; "" = no lower bound
  until: string; // YYYY-MM-DD; "" = no upper bound
}

const DEFAULT_FILTER: AlertsFilter = {
  status: "open",
  source: "",
  category: "",
  am: "",
  search: "",
  since: "",
  until: "",
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (tab === "overview") u.searchParams.delete("tab");
    else u.searchParams.set("tab", tab);
    window.history.replaceState({}, "", u);
  }, [tab]);

  const fetchAlerts = useCallback(async () => {
    setAlertsLoading(true);
    setAlertsError(null);
    try {
      const res = await fetch("/negative-keyword/api/alerts?limit=2000", {
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

  /** Distinct AM names present in the dataset — feeds the AM filter dropdown. */
  const amOptions = useMemo(() => {
    const names = new Set<string>();
    for (const a of alerts) {
      if (a.am_name && a.am_name.trim()) names.add(a.am_name.trim());
    }
    return Array.from(names).sort();
  }, [alerts]);

  /** Apply all client-side filters in one pass. */
  const filteredAlerts = useMemo(() => {
    const needle = filter.search.trim().toLowerCase();
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
      if (filter.am && (a.am_name ?? "") !== filter.am) return false;

      if (filter.since || filter.until) {
        const d = String(a.message_date ?? "").slice(0, 10);
        if (filter.since && d < filter.since) return false;
        if (filter.until && d > filter.until) return false;
      }

      if (needle) {
        const haystack = [
          a.business_name,
          a.am_name,
          a.sender,
          a.message_body,
          a.analysis,
          a.subject,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [alerts, filter]);

  return (
    <div>
      {/* Description strip — mirrors the old dashboard's intro paragraph */}
      <div className="nk-intro">
        <p className="nk-intro-blurb">
          Which customers are upset, where dissatisfaction was flagged, and which
          accounts need AM attention — surfaced from negative-keyword monitoring
          across App Chat, Email, SMS, Phone, and Video.
        </p>
        <div className="nk-intro-bullets">
          <span>✱ Last 14 days</span>
          <span>✱ Live Metabase data</span>
          <span>✱ One-click ticket creation</span>
        </div>
      </div>

      {/* Tab bar */}
      <div className="nk-tabs" role="tablist" aria-label="Negative Keyword Beacon tabs">
        {(
          [
            { id: "overview" as const, label: "Overview" },
            { id: "alerts" as const, label: `All alerts (${alerts.length})` },
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
              {scope === "am" ? "your book" : "all customers"} · refreshed{" "}
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
            setFilter((prev) => ({ ...prev, ...seed }));
            setTab("alerts");
          }}
        />
      )}

      {tab === "alerts" && (
        <AlertsTab
          alerts={filteredAlerts}
          totalAlerts={alerts.length}
          amOptions={amOptions}
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
