"use client";

/**
 * InboxFeed — umbrella landing surface. Phase E-9.
 *
 * Renders three sections (critical customers / needs AM call / open
 * tickets) sourced from /api/inbox/today. Each section shows a count, the
 * top 5 items, and a "View all →" link to the corresponding agent.
 *
 * Loading: per-section skeleton lines (3 placeholder rows). Errors render
 * inline per section so a broken source doesn't blank the whole inbox.
 *
 * Click behavior:
 *   - Critical customer → /customer/{entity_id}
 *   - Needs AM call → /post-payment/reports/{cb_customer_id}
 *   - Open ticket → opens the Linear url in a new tab (canonical truth);
 *     "View all →" goes to /escalation/tickets in-app.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

interface CriticalItem {
  entity_id: string;
  biz_name: string;
  am_name: string | null;
  cb_customer_id: string;
  composite: number;
  stoplight: "RED" | "YELLOW" | "GREEN";
  reason: string;
  suggested_action: string;
}

interface NeedsCallItem {
  cb_customer_id: string;
  biz_name: string;
  am_name: string | null;
  verdict: "icp" | "review" | "not_icp" | null;
  one_line: string;
  cb_created_at: string;
}

interface OpenTicketItem {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  customer_name: string;
  am_name: string;
  created_at: string;
  age_days: number;
}

interface InboxResponse {
  scope: {
    role: "admin" | "manager" | "am" | null;
    am_name: string | null;
    am_filtered: boolean;
  };
  critical_customers: { count: number; items: CriticalItem[] } | null;
  needs_am_call: { count: number; items: NeedsCallItem[] } | null;
  open_tickets: { count: number; items: OpenTicketItem[] } | null;
  generated_at: string;
  errors: Record<string, string>;
}

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = "-apple-system, Inter, system-ui, sans-serif";

// Watchfire palette (matches the rest of the umbrella)
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
};

const VERDICT_TONE: Record<string, { color: string; label: string }> = {
  icp: { color: C.patina, label: "ICP" },
  review: { color: C.brass, label: "Review" },
  not_icp: { color: C.ember, label: "Not ICP" },
};

export default function InboxFeed() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/inbox/today", { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`inbox ${res.status}`);
        }
        const json = (await res.json()) as InboxResponse;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setFetchError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (fetchError) {
    return (
      <Card>
        <p style={{ fontFamily: SANS, fontSize: 13, color: C.ember, margin: 0 }}>
          Couldn&apos;t load your inbox: {fetchError}
        </p>
      </Card>
    );
  }

  const scopeNote = data?.scope.am_filtered
    ? `Showing items in ${data.scope.am_name}&apos;s book.`
    : data?.scope.role
    ? "Showing items across the whole book."
    : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {scopeNote && (
        <div
          style={{
            fontFamily: SANS,
            fontSize: 11,
            color: C.text3,
            textAlign: "center",
            letterSpacing: "0.04em",
          }}
          dangerouslySetInnerHTML={{ __html: scopeNote }}
        />
      )}

      <CriticalCustomers
        section={data?.critical_customers ?? null}
        error={data?.errors.critical_customers}
        loading={loading}
      />
      <NeedsCall
        section={data?.needs_am_call ?? null}
        error={data?.errors.needs_am_call}
        loading={loading}
      />
      <OpenTickets
        section={data?.open_tickets ?? null}
        error={data?.errors.open_tickets}
        loading={loading}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Shared section chrome
 * ────────────────────────────────────────────────────────────────*/

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        padding: "18px 20px",
        boxShadow: "0 1px 2px rgba(43, 31, 20, 0.04)",
      }}
    >
      {children}
    </div>
  );
}

function SectionHeader({
  title,
  count,
  accent,
  viewAllHref,
  viewAllLabel,
}: {
  title: string;
  count: number | null;
  accent: string;
  viewAllHref: string;
  viewAllLabel: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        marginBottom: 10,
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: accent,
            transform: "translateY(-2px)",
          }}
        />
        <h2
          style={{
            margin: 0,
            fontFamily: SERIF,
            fontSize: 18,
            fontWeight: 500,
            color: C.text,
            letterSpacing: "-0.01em",
          }}
        >
          {title}
        </h2>
        {count !== null && (
          <span
            style={{
              fontFamily: SANS,
              fontSize: 11,
              color: C.text3,
              letterSpacing: "0.04em",
            }}
          >
            {count === 0 ? "none" : `${count} total`}
          </span>
        )}
      </div>
      <Link
        href={viewAllHref}
        style={{
          fontFamily: SANS,
          fontSize: 12,
          color: accent,
          textDecoration: "none",
          fontWeight: 500,
        }}
      >
        {viewAllLabel} →
      </Link>
    </div>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 18,
            borderRadius: 4,
            background: "rgba(43,31,20,0.06)",
            opacity: 0.6 - i * 0.08,
          }}
        />
      ))}
    </div>
  );
}

function EmptyState({ icon, message }: { icon: string; message: string }) {
  return (
    <div
      style={{
        fontFamily: SANS,
        fontSize: 12,
        color: C.text3,
        padding: "12px 0",
        textAlign: "center",
        fontStyle: "italic",
      }}
    >
      <span style={{ fontSize: 18 }} aria-hidden>
        {icon}
      </span>{" "}
      {message}
    </div>
  );
}

function ErrorRow({ error }: { error: string }) {
  return (
    <div
      style={{
        fontFamily: SANS,
        fontSize: 11,
        color: C.crimson,
        padding: "8px 0",
      }}
    >
      Couldn&apos;t load this section: {error}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Section: Critical customers
 * ────────────────────────────────────────────────────────────────*/

function CriticalCustomers({
  section,
  error,
  loading,
}: {
  section: { count: number; items: CriticalItem[] } | null;
  error?: string;
  loading: boolean;
}) {
  return (
    <Card>
      <SectionHeader
        title="Customers needing contact"
        count={section?.count ?? null}
        accent={C.ember}
        viewAllHref="/customer"
        viewAllLabel="Open Customer Beacon"
      />
      {error && <ErrorRow error={error} />}
      {!error && loading && <Skeleton rows={3} />}
      {!error && !loading && section && section.items.length === 0 && (
        <EmptyState
          icon="✨"
          message="No RED-stoplight customers in your scope. Beautiful."
        />
      )}
      {!error && section && section.items.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {section.items.map((c) => (
            <li key={c.entity_id} style={{ marginBottom: 4 }}>
              <Link
                href={`/customer/${c.entity_id}`}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  padding: "8px 0",
                  textDecoration: "none",
                  color: "inherit",
                  borderBottom: "1px solid rgba(212,194,155,0.4)",
                }}
              >
                <span
                  aria-label="Composite score"
                  title="Composite score"
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 11,
                    fontWeight: 600,
                    minWidth: 28,
                    color: C.ember,
                  }}
                >
                  {c.composite}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: SERIF,
                      fontSize: 14,
                      color: C.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.biz_name}
                  </div>
                  <div
                    style={{
                      fontFamily: SANS,
                      fontSize: 11,
                      color: C.text2,
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.reason}
                  </div>
                </div>
                {c.am_name && (
                  <span
                    style={{
                      fontFamily: SANS,
                      fontSize: 10,
                      color: C.text3,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.am_name}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Section: Post-Payment needs AM call
 * ────────────────────────────────────────────────────────────────*/

function NeedsCall({
  section,
  error,
  loading,
}: {
  section: { count: number; items: NeedsCallItem[] } | null;
  error?: string;
  loading: boolean;
}) {
  return (
    <Card>
      <SectionHeader
        title="Post-Payment verdicts awaiting AM call"
        count={section?.count ?? null}
        accent={C.patina}
        viewAllHref="/post-payment"
        viewAllLabel="Open Post-Payment"
      />
      {error && <ErrorRow error={error} />}
      {!error && loading && <Skeleton rows={3} />}
      {!error && !loading && section && section.items.length === 0 && (
        <EmptyState
          icon="✓"
          message="All recent verdicts have been actioned. Nothing waiting."
        />
      )}
      {!error && section && section.items.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {section.items.map((c) => {
            const tone = c.verdict ? VERDICT_TONE[c.verdict] : null;
            return (
              <li key={c.cb_customer_id} style={{ marginBottom: 4 }}>
                <Link
                  href={`/post-payment/reports/${c.cb_customer_id}`}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 10,
                    padding: "8px 0",
                    textDecoration: "none",
                    color: "inherit",
                    borderBottom: "1px solid rgba(212,194,155,0.4)",
                  }}
                >
                  {tone && (
                    <span
                      style={{
                        fontFamily: SANS,
                        fontSize: 10,
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: `${tone.color}15`,
                        color: tone.color,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tone.label}
                    </span>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: SERIF,
                        fontSize: 14,
                        color: C.text,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.biz_name}
                    </div>
                    <div
                      style={{
                        fontFamily: SANS,
                        fontSize: 11,
                        color: C.text2,
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.one_line}
                    </div>
                  </div>
                  {c.am_name && (
                    <span
                      style={{
                        fontFamily: SANS,
                        fontSize: 10,
                        color: C.text3,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.am_name}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Section: Open tickets
 * ────────────────────────────────────────────────────────────────*/

function OpenTickets({
  section,
  error,
  loading,
}: {
  section: { count: number; items: OpenTicketItem[] } | null;
  error?: string;
  loading: boolean;
}) {
  return (
    <Card>
      <SectionHeader
        title="Open tickets in your scope"
        count={section?.count ?? null}
        accent={C.crimson}
        viewAllHref="/escalation/tickets"
        viewAllLabel="Open Escalation"
      />
      {error && <ErrorRow error={error} />}
      {!error && loading && <Skeleton rows={3} />}
      {!error && !loading && section && section.items.length === 0 && (
        <EmptyState icon="🌤" message="Inbox zero on tickets. Enjoy the calm." />
      )}
      {!error && section && section.items.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {section.items.map((t) => (
            <li key={t.id} style={{ marginBottom: 4 }}>
              <a
                href={t.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  padding: "8px 0",
                  textDecoration: "none",
                  color: "inherit",
                  borderBottom: "1px solid rgba(212,194,155,0.4)",
                }}
              >
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 11,
                    fontWeight: 600,
                    minWidth: 56,
                    color: C.crimson,
                  }}
                >
                  {t.identifier}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: SERIF,
                      fontSize: 14,
                      color: C.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.title}
                  </div>
                  <div
                    style={{
                      fontFamily: SANS,
                      fontSize: 11,
                      color: C.text2,
                      marginTop: 2,
                    }}
                  >
                    {t.customer_name} · {t.state} ·{" "}
                    {t.age_days === 0
                      ? "today"
                      : t.age_days === 1
                      ? "1 day ago"
                      : `${t.age_days} days ago`}
                  </div>
                </div>
                {t.am_name && t.am_name !== "—" && (
                  <span
                    style={{
                      fontFamily: SANS,
                      fontSize: 10,
                      color: C.text3,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.am_name}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
