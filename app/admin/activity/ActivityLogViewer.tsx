"use client";

/**
 * ActivityLogViewer — admin activity table with filters + pagination + CSV.
 * Phase E-9.
 *
 * Self-contained client component. Calls /api/admin/activity for data,
 * URL-mirrors filters so links are shareable, debounces text inputs to
 * avoid hammering the endpoint on every keystroke.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import SectionErrorBoundary from "@/components/SectionErrorBoundary";

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = "-apple-system, Inter, system-ui, sans-serif";

const C = {
  text: "var(--zoca-text)",
  text2: "var(--zoca-text-2)",
  text3: "var(--zoca-text-3)",
  surface: "#F8EFD7",
  border: "#D4C29B",
  ember: "#C8431D",
  brass: "#D9A441",
  patina: "#4A7C59",
  crimson: "#7C2D12",
  lapis: "#2A4D5C",
};

const AGENT_TONE: Record<string, string> = {
  customer: C.ember,
  performance: C.brass,
  escalation: C.crimson,
  "post-payment": C.patina,
  umbrella: C.lapis,
};

interface ActivityRow {
  id: number;
  ts: string;
  email: string;
  role: string | null;
  am_name: string | null;
  agent: string;
  event_name: string;
  surface: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
}

interface ApiResponse {
  rows: ActivityRow[];
  total: number;
  facets: {
    agent_counts: Record<string, number>;
    event_counts: Record<string, number>;
    user_counts: Record<string, number>;
  };
  range: { from: string | null; to: string | null };
  page: number;
  limit: number;
  total_pages: number;
}

function isoToInputDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "";
  // YYYY-MM-DD for <input type="date" />
  return d.toISOString().slice(0, 10);
}

function topN<T extends Record<string, number>>(obj: T, n: number): Array<[string, number]> {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

export default function ActivityLogViewer() {
  const router = useRouter();
  const params = useSearchParams();

  // Filter state — initialized from URL so deep links work.
  const [user, setUser] = useState(params.get("user") ?? "");
  const [agent, setAgent] = useState(params.get("agent") ?? "");
  const [event, setEvent] = useState(params.get("event") ?? "");
  const [surface, setSurface] = useState(params.get("surface") ?? "");
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [to, setTo] = useState(params.get("to") ?? "");
  const [page, setPage] = useState(parseInt(params.get("page") ?? "1", 10) || 1);

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Push current filter state into the URL — keeps the back button useful
  // and lets admins share a filtered view with each other.
  useEffect(() => {
    const sp = new URLSearchParams();
    if (user) sp.set("user", user);
    if (agent) sp.set("agent", agent);
    if (event) sp.set("event", event);
    if (surface) sp.set("surface", surface);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    if (page > 1) sp.set("page", String(page));
    const qs = sp.toString();
    const next = qs ? `?${qs}` : "";
    router.replace(`/admin/activity${next}`, { scroll: false });
  }, [user, agent, event, surface, from, to, page, router]);

  // Debounced fetcher — wait 300ms after the latest filter change before
  // hitting the API, so typing in the user input doesn't run 6 queries.
  useEffect(() => {
    setLoading(true);
    setFetchError(null);
    const handle = setTimeout(async () => {
      try {
        const sp = new URLSearchParams();
        if (user) sp.set("user", user);
        if (agent) sp.set("agent", agent);
        if (event) sp.set("event", event);
        if (surface) sp.set("surface", surface);
        if (from) sp.set("from", new Date(from + "T00:00:00Z").toISOString());
        if (to) sp.set("to", new Date(to + "T00:00:00Z").toISOString());
        sp.set("page", String(page));
        sp.set("limit", "50");

        const res = await fetch(`/api/admin/activity?${sp.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(body.error || `admin/activity ${res.status}`);
        }
        const json = (await res.json()) as ApiResponse;
        setData(json);
      } catch (e) {
        setFetchError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [user, agent, event, surface, from, to, page]);

  const resetFilters = useCallback(() => {
    setUser("");
    setAgent("");
    setEvent("");
    setSurface("");
    setFrom("");
    setTo("");
    setPage(1);
  }, []);

  const csvHref = useMemo(() => {
    const sp = new URLSearchParams();
    if (user) sp.set("user", user);
    if (agent) sp.set("agent", agent);
    if (event) sp.set("event", event);
    if (surface) sp.set("surface", surface);
    if (from) sp.set("from", new Date(from + "T00:00:00Z").toISOString());
    if (to) sp.set("to", new Date(to + "T00:00:00Z").toISOString());
    sp.set("format", "csv");
    return `/api/admin/activity?${sp.toString()}`;
  }, [user, agent, event, surface, from, to]);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "16px 0 64px" }}>
      <div
        style={{
          marginBottom: 16,
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <h1
          style={{
            margin: 0,
            fontFamily: SERIF,
            fontSize: 26,
            fontWeight: 500,
            color: C.text,
            letterSpacing: "-0.01em",
          }}
        >
          Activity log
        </h1>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 12,
            color: C.text3,
          }}
        >
          {data?.total != null && (
            <span>
              {data.total.toLocaleString()} event
              {data.total === 1 ? "" : "s"} match
            </span>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <SectionErrorBoundary label="Filters">
        <div
          style={{
            background: C.surface,
            border: "1px solid " + C.border,
            borderRadius: 12,
            padding: "12px 16px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 10,
            marginBottom: 16,
            fontFamily: SANS,
            fontSize: 12,
          }}
        >
          <Field label="User email">
            <input
              type="text"
              value={user}
              onChange={(e) => {
                setUser(e.target.value);
                setPage(1);
              }}
              placeholder="exact@zoca.com"
              style={inputStyle}
            />
          </Field>
          <Field label="Agent">
            <select
              value={agent}
              onChange={(e) => {
                setAgent(e.target.value);
                setPage(1);
              }}
              style={inputStyle}
            >
              <option value="">all</option>
              <option value="customer">customer</option>
              <option value="performance">performance</option>
              <option value="escalation">escalation</option>
              <option value="post-payment">post-payment</option>
              <option value="umbrella">umbrella</option>
            </select>
          </Field>
          <Field label="Event">
            <input
              type="text"
              value={event}
              onChange={(e) => {
                setEvent(e.target.value);
                setPage(1);
              }}
              placeholder="e.g. customer_opened"
              style={inputStyle}
            />
          </Field>
          <Field label="Surface">
            <input
              type="text"
              value={surface}
              onChange={(e) => {
                setSurface(e.target.value);
                setPage(1);
              }}
              placeholder="e.g. v2_dashboard"
              style={inputStyle}
            />
          </Field>
          <Field label="From">
            <input
              type="date"
              value={from || isoToInputDate(data?.range.from ?? null)}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
              style={inputStyle}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
              style={inputStyle}
            />
          </Field>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 8,
              gridColumn: "1 / -1",
              justifyContent: "flex-end",
              marginTop: 4,
            }}
          >
            <button
              type="button"
              onClick={resetFilters}
              style={ghostBtnStyle}
            >
              Reset filters
            </button>
            <a href={csvHref} style={primaryBtnStyle} download>
              Export CSV
            </a>
          </div>
        </div>
      </SectionErrorBoundary>

      {/* Facets snapshot */}
      {data && page === 1 && (
        <SectionErrorBoundary label="Facets">
          <Facets
            agents={data.facets.agent_counts}
            events={data.facets.event_counts}
            users={data.facets.user_counts}
            onAgentClick={(a) => {
              setAgent(a);
              setPage(1);
            }}
            onEventClick={(e) => {
              setEvent(e);
              setPage(1);
            }}
            onUserClick={(u) => {
              setUser(u);
              setPage(1);
            }}
          />
        </SectionErrorBoundary>
      )}

      {/* Results table */}
      <SectionErrorBoundary label="Results">
        {fetchError && (
          <div
            style={{
              background: C.surface,
              border: "1px solid " + C.border,
              borderRadius: 12,
              padding: 16,
              fontFamily: SANS,
              fontSize: 13,
              color: C.crimson,
            }}
          >
            {fetchError}
          </div>
        )}

        {!fetchError && (
          <div
            style={{
              background: C.surface,
              border: "1px solid " + C.border,
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontFamily: SANS,
                  fontSize: 12,
                }}
              >
                <thead>
                  <tr
                    style={{
                      background: "#F0E4CC",
                      borderBottom: "1px solid " + C.border,
                    }}
                  >
                    <Th>Time</Th>
                    <Th>User</Th>
                    <Th>Role</Th>
                    <Th>Agent</Th>
                    <Th>Event</Th>
                    <Th>Surface</Th>
                    <Th>Entity</Th>
                    <Th>Metadata</Th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr>
                      <Td colSpan={8}>
                        <div
                          style={{
                            padding: 24,
                            textAlign: "center",
                            color: C.text3,
                          }}
                        >
                          Loading…
                        </div>
                      </Td>
                    </tr>
                  )}
                  {!loading && data?.rows.length === 0 && (
                    <tr>
                      <Td colSpan={8}>
                        <div
                          style={{
                            padding: 24,
                            textAlign: "center",
                            color: C.text3,
                          }}
                        >
                          No activity matches these filters.
                        </div>
                      </Td>
                    </tr>
                  )}
                  {!loading &&
                    data?.rows.map((r) => (
                      <tr
                        key={r.id}
                        style={{
                          borderBottom: "1px solid rgba(212,194,155,0.4)",
                        }}
                      >
                        <Td>
                          <span title={r.ts}>{fmtTs(r.ts)}</span>
                        </Td>
                        <Td>
                          <button
                            type="button"
                            onClick={() => {
                              setUser(r.email);
                              setPage(1);
                            }}
                            style={linkBtnStyle}
                          >
                            {r.email}
                          </button>
                        </Td>
                        <Td>
                          <span style={{ color: C.text3 }}>{r.role ?? "—"}</span>
                        </Td>
                        <Td>
                          <button
                            type="button"
                            onClick={() => {
                              setAgent(r.agent);
                              setPage(1);
                            }}
                            style={{
                              ...linkBtnStyle,
                              color: AGENT_TONE[r.agent] || C.text2,
                              fontWeight: 600,
                            }}
                          >
                            {r.agent}
                          </button>
                        </Td>
                        <Td>
                          <button
                            type="button"
                            onClick={() => {
                              setEvent(r.event_name);
                              setPage(1);
                            }}
                            style={linkBtnStyle}
                          >
                            {r.event_name}
                          </button>
                        </Td>
                        <Td>
                          <span style={{ color: C.text3 }}>
                            {r.surface ?? "—"}
                          </span>
                        </Td>
                        <Td>
                          <span
                            style={{
                              fontFamily: "ui-monospace, monospace",
                              fontSize: 11,
                              color: C.text3,
                            }}
                            title={r.entity_id ?? undefined}
                          >
                            {r.entity_id ? r.entity_id.slice(0, 8) + "…" : "—"}
                          </span>
                        </Td>
                        <Td>
                          {r.metadata ? (
                            <details style={{ maxWidth: 240 }}>
                              <summary
                                style={{
                                  cursor: "pointer",
                                  color: C.text3,
                                  fontSize: 11,
                                }}
                              >
                                {Object.keys(r.metadata).length} keys
                              </summary>
                              <pre
                                style={{
                                  marginTop: 4,
                                  fontFamily: "ui-monospace, monospace",
                                  fontSize: 10,
                                  background: "#F0E4CC",
                                  border: "1px solid " + C.border,
                                  borderRadius: 4,
                                  padding: 6,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                  maxHeight: 160,
                                  overflowY: "auto",
                                }}
                              >
                                {JSON.stringify(r.metadata, null, 2)}
                              </pre>
                            </details>
                          ) : (
                            <span style={{ color: C.text3 }}>—</span>
                          )}
                        </Td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {data && data.total_pages > 1 && (
              <div
                style={{
                  borderTop: "1px solid " + C.border,
                  padding: "10px 16px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontSize: 12,
                  color: C.text2,
                }}
              >
                <span>
                  Page {data.page} of {data.total_pages}
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setPage(Math.max(1, page - 1))}
                    disabled={page <= 1}
                    style={page <= 1 ? disabledBtnStyle : ghostBtnStyle}
                  >
                    ← Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage(Math.min(data.total_pages, page + 1))}
                    disabled={page >= data.total_pages}
                    style={
                      page >= data.total_pages ? disabledBtnStyle : ghostBtnStyle
                    }
                  >
                    Next →
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </SectionErrorBoundary>
    </div>
  );
}

/* ───────── Helpers + style atoms ───────── */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 11,
        color: "var(--zoca-text-3)",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {label}
      {children}
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "10px 14px",
        fontSize: 10,
        color: "var(--zoca-text-3)",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  colSpan,
}: {
  children: React.ReactNode;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      style={{
        padding: "8px 14px",
        verticalAlign: "top",
        color: "var(--zoca-text)",
      }}
    >
      {children}
    </td>
  );
}

function Facets({
  agents,
  events,
  users,
  onAgentClick,
  onEventClick,
  onUserClick,
}: {
  agents: Record<string, number>;
  events: Record<string, number>;
  users: Record<string, number>;
  onAgentClick: (a: string) => void;
  onEventClick: (e: string) => void;
  onUserClick: (u: string) => void;
}) {
  if (
    Object.keys(agents).length === 0 &&
    Object.keys(events).length === 0 &&
    Object.keys(users).length === 0
  ) {
    return null;
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 12,
        marginBottom: 16,
      }}
    >
      <FacetCard title="By agent">
        {topN(agents, 10).map(([a, n]) => (
          <FacetRow key={a} label={a} count={n} accent={AGENT_TONE[a] || "var(--zoca-text-2)"} onClick={() => onAgentClick(a)} />
        ))}
      </FacetCard>
      <FacetCard title="Top events">
        {topN(events, 8).map(([e, n]) => (
          <FacetRow key={e} label={e} count={n} onClick={() => onEventClick(e)} />
        ))}
      </FacetCard>
      <FacetCard title="Top users">
        {topN(users, 8).map(([u, n]) => (
          <FacetRow key={u} label={u} count={n} onClick={() => onUserClick(u)} />
        ))}
      </FacetCard>
    </div>
  );
}

function FacetCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "var(--zoca-surface, #F8EFD7)",
        border: "1px solid #D4C29B",
        borderRadius: 10,
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          fontFamily: SANS,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--zoca-text-3)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function FacetRow({
  label,
  count,
  accent,
  onClick,
}: {
  label: string;
  count: number;
  accent?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        background: "transparent",
        border: "none",
        padding: "3px 0",
        width: "100%",
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        cursor: "pointer",
        fontFamily: SANS,
        fontSize: 12,
        color: accent || "var(--zoca-text-2)",
        textAlign: "left",
      }}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontVariantNumeric: "tabular-nums",
          color: "var(--zoca-text-3)",
        }}
      >
        {count.toLocaleString()}
      </span>
    </button>
  );
}

function fmtTs(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const inputStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #D4C29B",
  borderRadius: 6,
  padding: "6px 8px",
  background: "white",
  fontFamily: "inherit",
  fontSize: 12,
  color: "var(--zoca-text)",
};

const ghostBtnStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #D4C29B",
  borderRadius: 6,
  padding: "6px 12px",
  background: "transparent",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  color: "var(--zoca-text)",
};

const primaryBtnStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid var(--zoca-text)",
  borderRadius: 6,
  padding: "6px 12px",
  background: "var(--zoca-text)",
  color: "#F0E4CC",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  textDecoration: "none",
  display: "inline-block",
};

const disabledBtnStyle: React.CSSProperties = {
  ...ghostBtnStyle,
  opacity: 0.4,
  cursor: "not-allowed",
};

const linkBtnStyle: React.CSSProperties = {
  appearance: "none",
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  color: "var(--zoca-text)",
  textDecoration: "underline",
  textDecorationStyle: "dotted",
  textDecorationColor: "rgba(43,31,20,0.3)",
};
