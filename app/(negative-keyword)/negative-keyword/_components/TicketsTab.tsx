"use client";

/**
 * Negative Keyword Beacon — Created Tickets tab. Phase NK-4.5.
 *
 * Read-only table of open retention-risk tickets in Linear (Todo / In
 * Progress / In Review states). Hits the same Linear-backed endpoint
 * that NK-3 built.
 *
 * Lazy-loads on first tab click — Linear is rate-limited and the
 * average AM probably won't open this tab every session.
 */

import { useCallback, useEffect, useState } from "react";

interface OpenTicket {
  ticket_id: string;
  url: string;
  business: string;
  am: string;
  category: string;
  alert_date: string;
  status: string;
  status_type: string;
  created_at: string;
}

const STATUS_TONE: Record<string, string> = {
  Todo: "nk-pill-ember",
  "In Progress": "nk-pill-brass",
  "In Review": "nk-pill-lapis",
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export default function TicketsTab() {
  const [tickets, setTickets] = useState<OpenTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<string>("all");

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/negative-keyword/api/tickets", {
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      setTickets(data.tickets || []);
      setScope(data.scope || "all");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTickets();
  }, [fetchTickets]);

  return (
    <div className="nk-tickets-tab">
      <div className="nk-tickets-toolbar">
        <div className="nk-tickets-stamp">
          {tickets.length} open ticket{tickets.length === 1 ? "" : "s"} ·{" "}
          {scope === "am" ? "assigned to you" : "across the team"}
        </div>
        <button
          type="button"
          className="nk-refresh"
          onClick={() => void fetchTickets()}
          disabled={loading}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="nk-error" role="alert">
          Couldn&apos;t load tickets: {error}
        </div>
      )}

      {loading && tickets.length === 0 ? (
        <div className="nk-empty">Loading tickets from Linear…</div>
      ) : tickets.length === 0 ? (
        <div className="nk-empty">
          No open retention-risk tickets in Linear. Either nobody&apos;s created
          one yet, or LINEAR_API_KEY isn&apos;t configured for this environment.
        </div>
      ) : (
        <div className="surface nk-table-card">
          <div className="nk-table-wrap">
            <table className="nk-table">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Business</th>
                  <th>Assignee</th>
                  <th>Category</th>
                  <th>Alert date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.ticket_id}>
                    <td>
                      <a
                        href={t.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="nk-link nk-mono"
                      >
                        {t.ticket_id}
                      </a>
                    </td>
                    <td>{t.business}</td>
                    <td>{t.am}</td>
                    <td>{t.category}</td>
                    <td>{t.alert_date}</td>
                    <td>
                      <span className={`nk-pill ${STATUS_TONE[t.status] ?? "nk-pill-smoke"}`}>
                        {t.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="nk-tickets-foot">
            Tickets sorted by created date — newest first. Click ticket ID to open in
            Linear.
          </div>
        </div>
      )}
    </div>
  );
}
