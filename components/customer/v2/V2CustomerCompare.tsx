"use client";

/**
 * V2CustomerCompare — Phase E-14.
 *
 * Side-by-side comparison of up to 3 customers across 4 dimension groups:
 *   1. Identity + health drivers
 *   2. Comms + lifecycle
 *   3. Performance outcomes
 *   4. Operational state (billing / deals / tickets / AM actions)
 *
 * Each dimension is a row; each customer is a column. The cell with the
 * "worst" value in numerical comparison rows gets an ember tint so the
 * eye finds the outlier without doing math.
 *
 * Empty/missing customers don't render a column. Failure modes (no entities,
 * 1 entity, all unknown) render explanatory empty states.
 */

import Link from "next/link";
import type { ScoredCustomerV2 } from "@/lib/customer/types";

// Watchfire palette (matches the rest of the app — kept inline to avoid
// dragging in a styled-components dep or restyling the consumer).
const C = {
  text: "#2B1F14",
  text2: "#4A3D2C",
  text3: "#6E5F50",
  parchment: "#F0E4CC",
  surface: "#F8EFD7",
  border: "rgba(43, 31, 20, 0.16)",
  borderStrong: "rgba(43, 31, 20, 0.28)",
  emberBg: "rgba(200, 67, 29, 0.10)",
  emberBorder: "rgba(200, 67, 29, 0.32)",
  ember: "#7C2D12",
  patinaBg: "rgba(74, 124, 89, 0.10)",
  patinaBorder: "rgba(74, 124, 89, 0.32)",
  patina: "#3A6346",
  brassBg: "rgba(217, 164, 65, 0.14)",
  brassBorder: "rgba(217, 164, 65, 0.36)",
  brass: "#8B5E10",
} as const;

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = "-apple-system, Inter, system-ui, sans-serif";

interface Props {
  customers: ScoredCustomerV2[];
  /** Entity ids requested in the URL that we couldn't resolve from the snapshot. */
  missingIds: string[];
  /** All entity ids the URL asked for (resolved + missing). For the header. */
  requestedIds: string[];
  /** When the snapshot was generated. Renders as a "data as of" hint. */
  snapshotGeneratedAt: string | null;
}

export default function V2CustomerCompare({
  customers,
  missingIds,
  requestedIds,
  snapshotGeneratedAt,
}: Props) {
  // ---- Empty states ------------------------------------------------------
  if (requestedIds.length === 0) {
    return (
      <EmptyState
        title="Pick customers to compare"
        body="Use the checkboxes on the customer dashboard, the Cmd+K palette ('Compare customers'), or pass ?entities=A,B,C in the URL to compare up to 3 customers side-by-side."
      />
    );
  }
  if (customers.length === 0) {
    return (
      <EmptyState
        title="None of those customers are in today's book"
        body={`Couldn't find any of ${requestedIds.length} requested entity_id${requestedIds.length === 1 ? "" : "s"} in the latest snapshot. They may have churned, been excluded, or never been onboarded.`}
        hint={requestedIds.join(", ")}
      />
    );
  }
  if (customers.length === 1) {
    return (
      <EmptyState
        title="Comparison needs at least 2 customers"
        body="You've selected one. Add at least one more entity_id to the URL or use the checkbox UI on the dashboard."
        hint={`Currently viewing: ${customers[0].company || customers[0].entity_id}`}
        action={
          <Link
            href={`/360/${customers[0].entity_id}`}
            style={{ color: C.brass, textDecoration: "underline" }}
          >
            Open this customer's 360 view instead →
          </Link>
        }
      />
    );
  }

  // ---- Worst-value highlighting ------------------------------------------
  // For each numeric row, pre-compute the index of the worst customer so the
  // cell renderer can ember-tint it. Defining "worst" varies by row, so we
  // pass per-row comparator functions below; each row's comparator returns
  // the index of the worst customer, or null if no comparison makes sense.
  const cs = customers;
  const worstIdx = (extractor: (c: ScoredCustomerV2) => number | null) => {
    let worst = -1;
    let worstVal = -Infinity;
    cs.forEach((c, i) => {
      const v = extractor(c);
      if (v === null) return;
      if (v > worstVal) {
        worstVal = v;
        worst = i;
      }
    });
    return worst >= 0 ? worst : null;
  };
  const bestIdx = (extractor: (c: ScoredCustomerV2) => number | null) => {
    let best = -1;
    let bestVal = Infinity;
    cs.forEach((c, i) => {
      const v = extractor(c);
      if (v === null) return;
      if (v < bestVal) {
        bestVal = v;
        best = i;
      }
    });
    return best >= 0 ? best : null;
  };

  return (
    <div
      style={{
        fontFamily: SANS,
        color: C.text,
        maxWidth: 1400,
        margin: "0 auto",
        padding: "16px 24px 48px",
      }}
    >
      {/* Page heading */}
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            margin: 0,
            fontFamily: SERIF,
            fontSize: 28,
            fontWeight: 500,
            color: C.text,
            letterSpacing: "-0.01em",
          }}
        >
          Comparing {customers.length} customer{customers.length === 1 ? "" : "s"}
        </h1>
        <p
          style={{
            margin: "4px 0 0",
            fontSize: 12,
            color: C.text3,
          }}
        >
          Side-by-side health, comms, performance, and operational state.
          {snapshotGeneratedAt && (
            <>
              {" · "}Data as of{" "}
              {new Date(snapshotGeneratedAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </>
          )}
          {missingIds.length > 0 && (
            <>
              {" · "}
              <span style={{ color: C.ember }}>
                {missingIds.length} not found in snapshot: {missingIds.join(", ")}
              </span>
            </>
          )}
        </p>
      </div>

      {/* ---- Customer header strip ---- */}
      <CompareGrid customers={cs}>
        {(c) => <CustomerHeader customer={c} />}
      </CompareGrid>

      {/* ---- Group 1: Identity + health drivers ---- */}
      <Section title="Identity + health drivers">
        <Row
          label="Account manager"
          customers={cs}
          render={(c) => <code style={{ fontSize: 12 }}>{c.am_name || "—"}</code>}
        />
        <Row label="Pod" customers={cs} render={(c) => c.pod || "—"} />
        <Row
          label="Stoplight"
          customers={cs}
          render={(c) => <StoplightChip stoplight={c.signals_v2.stoplight} />}
        />
        <Row
          label="Composite score"
          customers={cs}
          render={(c) => (
            <span style={{ fontWeight: 600, fontSize: 16 }}>
              {c.signals_v2.composite}
            </span>
          )}
          worstAt={worstIdx((c) => c.signals_v2.composite)}
        />
        <Row
          label="7-day trajectory"
          customers={cs}
          render={(c) => (
            <TrajectoryChip
              trajectory={c.signals_v2.trajectory_7d}
              prev={c.signals_v2.composite_7d_ago}
              now={c.signals_v2.composite}
            />
          )}
        />
        <Row
          label="Why at this tier"
          customers={cs}
          render={(c) => (
            <span style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 12 }}>
              {c.signals_v2.reason_one_line || c.signals_v2.notes || "—"}
            </span>
          )}
        />
        <Row
          label="Suggested action"
          customers={cs}
          render={(c) => (
            <span style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 12 }}>
              {c.signals_v2.suggested_action || "—"}
            </span>
          )}
        />
      </Section>

      {/* ---- Group 2: Comms + lifecycle ---- */}
      <Section title="Comms + lifecycle">
        <Row
          label="Lifecycle state"
          customers={cs}
          render={(c) => (
            <LifecycleChip lifecycle={c.lifecycle_state ?? "active"} />
          )}
        />
        <Row
          label="Signal state (E-11)"
          customers={cs}
          render={(c) => <span style={{ fontSize: 12 }}>{c.signal_state ?? "ready"}</span>}
        />
        <Row
          label="Comms last 30d"
          customers={cs}
          render={(c) => (
            <span>
              {c.metrics.total_30d} total · {c.metrics.in_30d} in · {c.metrics.out_30d} out
            </span>
          )}
          bestAt={bestIdx((c) => -c.metrics.total_30d)} // bestIdx looks for smallest, so negate to find largest
        />
        <Row
          label="Channels used 30d"
          customers={cs}
          render={(c) => c.metrics.channels_used_30d || "—"}
        />
        <Row
          label="Days since client wrote"
          customers={cs}
          render={(c) => formatDaysSince(c.metrics.days_since_in)}
          worstAt={worstIdx((c) => c.metrics.days_since_in)}
        />
        <Row
          label="Days since we wrote"
          customers={cs}
          render={(c) => formatDaysSince(c.metrics.days_since_out)}
          worstAt={worstIdx((c) => c.metrics.days_since_out)}
        />
      </Section>

      {/* ---- Group 3: Performance outcomes ---- */}
      <Section title="Performance outcomes">
        <Row
          label="GBP clicks (current complete month)"
          customers={cs}
          render={(c) =>
            c.performance?.gbp_clicks_current_complete_month != null
              ? c.performance.gbp_clicks_current_complete_month.toLocaleString()
              : "—"
          }
          bestAt={bestIdx((c) => {
            const v = c.performance?.gbp_clicks_current_complete_month;
            return v == null ? null : -v;
          })}
        />
        <Row
          label="GBP clicks drop from peak"
          customers={cs}
          render={(c) =>
            c.performance?.gbp_clicks_drop_pct != null
              ? `${c.performance.gbp_clicks_drop_pct.toFixed(0)}%`
              : "—"
          }
          worstAt={worstIdx((c) => c.performance?.gbp_clicks_drop_pct ?? null)}
        />
        <Row
          label="YTD leads"
          customers={cs}
          render={(c) =>
            c.performance?.ytd_leads != null
              ? c.performance.ytd_leads.toLocaleString()
              : "—"
          }
          bestAt={bestIdx((c) => {
            const v = c.performance?.ytd_leads;
            return v == null ? null : -v;
          })}
        />
        <Row
          label="YTD leads vs. prior YTD"
          customers={cs}
          render={(c) =>
            c.performance?.ytd_leads_change_pct != null
              ? `${c.performance.ytd_leads_change_pct >= 0 ? "+" : ""}${c.performance.ytd_leads_change_pct.toFixed(0)}%`
              : "—"
          }
        />
        <Row
          label="Active rankings (top-3 / top-10)"
          customers={cs}
          render={(c) =>
            c.performance?.active_ranking_count != null
              ? `${c.performance.active_ranking_count} (${c.performance.rankings_top_3 ?? 0}T3 / ${c.performance.rankings_top_10 ?? 0}T10)`
              : "—"
          }
        />
        <Row
          label="Reviews last 12 weeks"
          customers={cs}
          render={(c) =>
            c.performance?.reviews_last_12_weeks_total != null
              ? `${c.performance.reviews_last_12_weeks_total} (${c.performance.weeks_with_zero_reviews ?? 0} zero-weeks)`
              : "—"
          }
        />
        <Row
          label="Performance flag"
          customers={cs}
          render={(c) =>
            c.performance?.flag
              ? (
                <span style={{ color: C.ember, fontWeight: 600 }}>
                  Flagged · {c.performance.flag_reasons.slice(0, 2).join(", ")}
                </span>
              )
              : <span style={{ color: C.patina }}>OK</span>
          }
        />
      </Section>

      {/* ---- Group 4: Operational state ---- */}
      <Section title="Operational state">
        <Row
          label="Subscription status"
          customers={cs}
          render={(c) => (
            <span style={{ fontSize: 12 }}>
              {c.cb_status || "—"} · {c.auto_collection || "—"}
            </span>
          )}
        />
        <Row
          label="Plan amount (monthly)"
          customers={cs}
          render={(c) =>
            c.plan_amount > 0
              ? `$${c.plan_amount.toFixed(0)}`
              : "—"
          }
        />
        <Row
          label="Unpaid invoices"
          customers={cs}
          render={(c) => {
            if (!c.billing) return "—";
            const n = c.billing.unpaid_invoice_count;
            const amt = c.billing.total_amount_due_cents / 100;
            return n > 0
              ? `${n} · $${amt.toFixed(0)}${c.billing.has_ach_in_progress ? " · ACH in progress" : ""}`
              : "None";
          }}
          worstAt={worstIdx((c) => c.billing?.unpaid_invoice_count ?? null)}
        />
        <Row
          label="HubSpot open deals"
          customers={cs}
          render={(c) => {
            const n = c.hubspot?.open_deal_count;
            if (n == null) return "—";
            const amt = c.hubspot?.total_open_amount;
            return n > 0
              ? `${n}${amt ? ` · $${amt.toLocaleString()}` : ""}`
              : "None";
          }}
        />
        <Row
          label="Last HubSpot call sentiment"
          customers={cs}
          render={(c) => {
            const lc = c.hubspot?.last_call;
            if (!lc) return "—";
            return (
              <span>
                <SentimentChip sentiment={lc.sentiment} />
                {" · "}
                <span style={{ color: C.text3, fontSize: 11 }}>
                  {new Date(lc.date).toLocaleDateString()}
                </span>
              </span>
            );
          }}
        />
        <Row
          label="Open tickets"
          customers={cs}
          render={(c) => {
            const open = c.tickets?.open_count ?? c.tickets?.open_tickets_30d ?? 0;
            const stale = c.tickets?.open_stale_count ?? 0;
            return open > 0
              ? `${open}${stale > 0 ? ` (${stale} stale)` : ""}`
              : "None";
          }}
          worstAt={worstIdx((c) =>
            (c.tickets?.open_count ?? c.tickets?.open_tickets_30d ?? null),
          )}
        />
        <Row
          label="Oldest open ticket age"
          customers={cs}
          render={(c) =>
            c.tickets?.oldest_open_age_days != null
              ? `${c.tickets.oldest_open_age_days}d`
              : "—"
          }
          worstAt={worstIdx((c) => c.tickets?.oldest_open_age_days ?? null)}
        />
      </Section>

      {/* ---- Footer actions ---- */}
      <div style={{ marginTop: 32, display: "flex", gap: 12, flexWrap: "wrap" }}>
        {customers.map((c) => (
          <Link
            key={c.entity_id}
            href={`/360/${c.entity_id}`}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              background: C.surface,
              border: `1px solid ${C.borderStrong}`,
              borderRadius: 6,
              color: C.text,
              textDecoration: "none",
              fontFamily: SERIF,
            }}
          >
            Open {c.company || c.entity_id.slice(0, 8)} →
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function CompareGrid({
  customers,
  children,
}: {
  customers: ScoredCustomerV2[];
  children: (c: ScoredCustomerV2, i: number) => React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `220px repeat(${customers.length}, 1fr)`,
        gap: 0,
        marginBottom: 16,
      }}
    >
      <div /> {/* spacer aligning with Row label column */}
      {customers.map((c, i) => (
        <div key={c.entity_id} style={{ padding: "0 12px" }}>
          {children(c, i)}
        </div>
      ))}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        marginTop: 20,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        background: "rgba(248, 239, 215, 0.5)",
      }}
    >
      <h2
        style={{
          margin: 0,
          padding: "10px 16px",
          fontFamily: SERIF,
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: "0.02em",
          color: C.text,
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        {title}
      </h2>
      <div style={{ padding: "4px 0" }}>{children}</div>
    </section>
  );
}

function Row({
  label,
  customers,
  render,
  worstAt,
  bestAt,
}: {
  label: string;
  customers: ScoredCustomerV2[];
  render: (c: ScoredCustomerV2, i: number) => React.ReactNode;
  /** Index of customer whose value is "worst" — tint that cell ember. */
  worstAt?: number | null;
  /** Index of customer whose value is "best" — tint that cell patina. */
  bestAt?: number | null;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `220px repeat(${customers.length}, 1fr)`,
        gap: 0,
        borderTop: `1px solid ${C.border}`,
        padding: "10px 0",
      }}
    >
      <div
        style={{
          padding: "0 16px",
          fontSize: 11,
          color: C.text3,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          alignSelf: "center",
        }}
      >
        {label}
      </div>
      {customers.map((c, i) => {
        const isWorst = worstAt === i;
        const isBest = bestAt === i;
        return (
          <div
            key={c.entity_id}
            style={{
              padding: "4px 12px",
              fontSize: 13,
              color: C.text,
              background: isWorst
                ? C.emberBg
                : isBest
                  ? C.patinaBg
                  : "transparent",
              borderRadius: 4,
              alignSelf: "center",
              minHeight: 24,
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 4,
            }}
          >
            {render(c, i)}
          </div>
        );
      })}
    </div>
  );
}

function CustomerHeader({ customer }: { customer: ScoredCustomerV2 }) {
  return (
    <div
      style={{
        padding: 14,
        background: C.parchment,
        border: `1px solid ${C.borderStrong}`,
        borderRadius: 10,
      }}
    >
      <div
        style={{
          fontFamily: SERIF,
          fontSize: 17,
          fontWeight: 500,
          color: C.text,
          letterSpacing: "-0.01em",
          marginBottom: 2,
        }}
      >
        {customer.company || customer.entity_id.slice(0, 8)}
      </div>
      <div style={{ fontSize: 11, color: C.text3, fontFamily: "ui-monospace, SF Mono, monospace" }}>
        {customer.entity_id.slice(0, 14)}…
      </div>
    </div>
  );
}

function StoplightChip({ stoplight }: { stoplight: string }) {
  const tone =
    stoplight === "RED"
      ? { bg: C.emberBg, border: C.emberBorder, color: C.ember, label: "RED" }
      : stoplight === "YELLOW"
        ? { bg: C.brassBg, border: C.brassBorder, color: C.brass, label: "YELLOW" }
        : { bg: C.patinaBg, border: C.patinaBorder, color: C.patina, label: "GREEN" };
  return (
    <span
      style={{
        padding: "3px 10px",
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.06em",
        color: tone.color,
      }}
    >
      {tone.label}
    </span>
  );
}

function TrajectoryChip({
  trajectory,
  prev,
  now,
}: {
  trajectory: string;
  prev: number | null;
  now: number;
}) {
  const delta = prev != null ? now - prev : null;
  const arrow =
    trajectory === "improving"
      ? "↓" // composite went DOWN = improving (lower score = healthier)
      : trajectory === "worsening"
        ? "↑"
        : trajectory === "stable"
          ? "→"
          : "?";
  const color =
    trajectory === "improving"
      ? C.patina
      : trajectory === "worsening"
        ? C.ember
        : C.text3;
  return (
    <span style={{ color, fontSize: 12, fontWeight: 600 }}>
      {arrow} {trajectory}
      {delta != null && (
        <span style={{ color: C.text3, marginLeft: 6, fontWeight: 400 }}>
          ({delta > 0 ? "+" : ""}
          {delta})
        </span>
      )}
    </span>
  );
}

function LifecycleChip({ lifecycle }: { lifecycle: string }) {
  if (lifecycle === "active") return <span style={{ color: C.text3 }}>active</span>;
  // F-purge-churned — recently-churned customers are dropped from the snapshot,
  // so this chip only renders for newly_onboarded / resurrected.
  const tone =
    lifecycle === "newly_onboarded"
      ? { bg: C.patinaBg, color: C.patina }
      : { bg: C.brassBg, color: C.brass };
  return (
    <span
      style={{
        padding: "2px 8px",
        background: tone.bg,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        color: tone.color,
      }}
    >
      {lifecycle.replace(/_/g, " ")}
    </span>
  );
}

function SentimentChip({ sentiment }: { sentiment: string }) {
  const tone =
    sentiment === "warm"
      ? { color: C.patina, label: "warm" }
      : sentiment === "frustrated"
        ? { color: C.ember, label: "frustrated" }
        : sentiment === "neutral"
          ? { color: C.text3, label: "neutral" }
          : { color: C.text3, label: "unknown" };
  return <span style={{ color: tone.color, fontWeight: 600 }}>{tone.label}</span>;
}

function formatDaysSince(d: number): string {
  if (d === 9999) return "never";
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  return `${d}d ago`;
}

function EmptyState({
  title,
  body,
  hint,
  action,
}: {
  title: string;
  body: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        maxWidth: 640,
        margin: "48px auto",
        padding: 32,
        textAlign: "center",
        fontFamily: SANS,
        color: C.text,
      }}
    >
      <h1
        style={{
          margin: 0,
          marginBottom: 10,
          fontFamily: SERIF,
          fontSize: 22,
          fontWeight: 500,
        }}
      >
        {title}
      </h1>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: C.text2 }}>{body}</p>
      {hint && (
        <p
          style={{
            marginTop: 10,
            fontSize: 11,
            color: C.text3,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {hint}
        </p>
      )}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}
