"use client";

/**
 * Customer360 client — Phase E-9.
 *
 * Hero card + four sections, each wrapped in SectionErrorBoundary so any
 * one source blowing up doesn't blank the whole view. Page-level
 * FreshnessIndicator on the snapshot timestamp.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import SectionErrorBoundary from "@/components/SectionErrorBoundary";
import FreshnessIndicator from "@/components/FreshnessIndicator";
import CalculationTooltip from "@/components/CalculationTooltip";
import SuggestedActions from "@/components/ai/SuggestedActions";
// AskPanel is now mounted globally in app/layout.tsx — no per-page wiring
// needed. It picks up scope from usePathname() automatically.

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

const STOPLIGHT_COLOR: Record<"RED" | "YELLOW" | "GREEN", string> = {
  RED: C.ember,
  YELLOW: C.brass,
  GREEN: C.patina,
};

interface MetaBlock {
  entity_id: string;
  biz_name: string;
  am_name: string | null;
  ae_name: string | null;
  cb_customer_id: string | null;
  pod: string | null;
  snapshot_generated_at: string | null;
  generated_at: string;
}

interface SignalsBlock {
  composite: number;
  tier: "HIGH" | "MEDIUM" | "LOW" | "HEALTHY";
  stoplight: "RED" | "YELLOW" | "GREEN";
  sub_scores: {
    we_silent: number;
    client_silent: number;
    response_drop: number;
    volume_collapse: number;
    usage: number;
    billing: number;
  };
  flag_performance: boolean;
  flag_tickets: boolean;
  reason_one_line: string;
  suggested_action: string;
  lifecycle_state?: string;
  last_any_iso: string | null;
  last_in_iso: string | null;
  last_out_iso: string | null;
  trajectory_7d: string;
}

interface PerformanceBlock {
  vertical: string;
  city: string | null;
  state: string | null;
  current_month_clicks: number | null;
  current_month: string | null;
  peak_month_clicks: number | null;
  peak_month: string | null;
  dip_pct_complete_months: number | null;
  active_keywords_count: number;
  top3_keywords_count: number;
  top10_keywords_count: number;
  ytd_leads: number;
  predicted_6_month_leads: number | null;
  weekly_review_target: number | null;
}

interface EscalationBlock {
  open_count: number;
  open_recent: Array<{
    id: string;
    identifier: string;
    title: string;
    url: string;
    state: string;
    created_at: string;
    age_days: number;
  }>;
  closed_30d_count: number;
}

interface PostPaymentBlock {
  cb_customer_id: string;
  status: string;
  verdict: "icp" | "review" | "not_icp" | null;
  needs_am_call: boolean;
  verdict_one_line: string | null;
  key_flags: string[] | null;
  report_docx_url: string | null;
  cb_created_at: string;
  updated_at: string;
}

interface Customer360Response {
  meta: MetaBlock;
  signals: SignalsBlock | null;
  performance: PerformanceBlock | null;
  escalation: EscalationBlock | null;
  post_payment: PostPaymentBlock | null;
  errors: Record<string, string>;
}

export default function Customer360({ entityId }: { entityId: string }) {
  const [data, setData] = useState<Customer360Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/customer-360/${encodeURIComponent(entityId)}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`customer-360 ${res.status}`);
        const json = (await res.json()) as Customer360Response;
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
  }, [entityId]);

  if (loading && !data) {
    return (
      <div style={{ padding: "32px 0", maxWidth: 1000, margin: "0 auto" }}>
        <SkeletonHero />
        <div style={{ height: 16 }} />
        <SkeletonSection />
        <SkeletonSection />
        <SkeletonSection />
        <SkeletonSection />
      </div>
    );
  }

  if (fetchError) {
    return (
      <div
        style={{
          maxWidth: 720,
          margin: "60px auto",
          background: C.surface,
          border: "1px solid " + C.border,
          borderRadius: 14,
          padding: 24,
          textAlign: "center",
          fontFamily: SANS,
          color: C.crimson,
        }}
      >
        Couldn&apos;t load Customer 360: {fetchError}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "16px 0 64px" }}>
      <Hero meta={data.meta} signals={data.signals} />

      {/* Phase E-9 — proactive Beacon AI strip. 2-3 contextual actions
          (ask / draft / navigate) rendered above the main sections. */}
      <SectionErrorBoundary label="Beacon AI suggestions">
        <SuggestedActions scope={{ kind: "customer-360", entityId }} />
      </SectionErrorBoundary>

      <SectionErrorBoundary label="Comms perspective">
        <CommsPerspectivePanel entityId={entityId} />
      </SectionErrorBoundary>

      <SectionErrorBoundary label="Signals">
        <SignalsSection signals={data.signals} error={data.errors.snapshot} />
      </SectionErrorBoundary>

      <SectionErrorBoundary label="Performance">
        <PerformanceSection
          performance={data.performance}
          error={data.errors.performance}
          entityId={entityId}
        />
      </SectionErrorBoundary>

      <SectionErrorBoundary label="Escalations">
        <EscalationSection
          escalation={data.escalation}
          error={data.errors.escalation}
          bizName={data.meta.biz_name}
        />
      </SectionErrorBoundary>

      <SectionErrorBoundary label="Post-Payment">
        <PostPaymentSection
          postPayment={data.post_payment}
          error={data.errors.post_payment}
          cbCustomerId={data.meta.cb_customer_id}
        />
      </SectionErrorBoundary>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
 * Hero — bizname, AM, pod, composite + stoplight, freshness
 * ───────────────────────────────────────────────────────────────*/
function Hero({ meta, signals }: { meta: MetaBlock; signals: SignalsBlock | null }) {
  const stoplightColor = signals ? STOPLIGHT_COLOR[signals.stoplight] : C.text3;
  return (
    <div
      style={{
        background: C.surface,
        border: "1px solid " + C.border,
        borderRadius: 16,
        padding: "20px 24px",
        marginBottom: 16,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: "1 1 320px", minWidth: 280 }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: C.text3,
            fontFamily: SANS,
            marginBottom: 4,
          }}
        >
          Customer 360
        </div>
        <h1
          style={{
            margin: 0,
            fontFamily: SERIF,
            fontSize: "clamp(22px, 3vw, 32px)",
            fontWeight: 500,
            letterSpacing: "-0.015em",
            color: C.text,
          }}
        >
          {meta.biz_name}
        </h1>
        <div
          style={{
            display: "flex",
            gap: 14,
            flexWrap: "wrap",
            marginTop: 8,
            fontFamily: SANS,
            fontSize: 12,
            color: C.text2,
          }}
        >
          {meta.am_name && <span>AM · {meta.am_name}</span>}
          {meta.pod && <span>{meta.pod}</span>}
          {meta.entity_id && (
            <span style={{ fontFamily: "ui-monospace, monospace", color: C.text3 }}>
              {meta.entity_id.slice(0, 8)}…
            </span>
          )}
        </div>
        <div style={{ marginTop: 10 }}>
          <FreshnessIndicator
            ts={meta.snapshot_generated_at}
            source="Customer Beacon snapshot · hourly cron"
          />
        </div>
      </div>

      {signals && (
        <div
          style={{
            background: "#F0E4CC",
            border: `1px solid ${stoplightColor}`,
            borderLeft: `4px solid ${stoplightColor}`,
            borderRadius: 12,
            padding: "12px 18px",
            minWidth: 220,
            flex: "0 0 auto",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              fontFamily: SANS,
              fontSize: 11,
              color: C.text3,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              marginBottom: 4,
            }}
          >
            <span>Composite</span>
            <CalculationTooltip
              label="Composite score"
              body={
                <>
                  50% comms signals · 30% product usage · 20% billing.
                  Higher = worse. RED stoplight ≥ 65 (or billing-crisis override).
                </>
              }
            />
          </div>
          <div
            style={{
              fontFamily: SERIF,
              fontSize: 30,
              fontWeight: 500,
              color: stoplightColor,
              lineHeight: 1,
            }}
          >
            {signals.composite}
            <span style={{ fontSize: 14, color: C.text3, marginLeft: 6 }}>/100</span>
          </div>
          <div
            style={{
              marginTop: 6,
              fontFamily: SANS,
              fontSize: 11,
              color: stoplightColor,
              fontWeight: 600,
              letterSpacing: "0.04em",
            }}
          >
            {signals.stoplight} · {signals.tier}
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
 * Section card chrome
 * ───────────────────────────────────────────────────────────────*/
function Card({
  title,
  accent,
  rightSlot,
  children,
}: {
  title: string;
  accent: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: C.surface,
        border: "1px solid " + C.border,
        borderRadius: 14,
        padding: "16px 20px",
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 12,
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
        </div>
        {rightSlot}
      </div>
      {children}
    </section>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "20px 0",
        textAlign: "center",
        fontFamily: SANS,
        fontSize: 12,
        color: C.text3,
        fontStyle: "italic",
      }}
    >
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
        padding: "10px 0",
      }}
    >
      Couldn&apos;t load this section: {error}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
 * Section: Signals (Customer Beacon)
 * ───────────────────────────────────────────────────────────────*/
function SignalsSection({
  signals,
  error,
}: {
  signals: SignalsBlock | null;
  error?: string;
}) {
  return (
    <Card
      title="Signals"
      accent={C.ember}
      rightSlot={
        <Link
          href={signals ? `/customer/${encodeURIComponent("")}` : "/customer"}
          style={{ fontFamily: SANS, fontSize: 12, color: C.ember, textDecoration: "none", fontWeight: 500 }}
        >
          Customer Beacon →
        </Link>
      }
    >
      {error && <ErrorRow error={error} />}
      {!error && !signals && (
        <Empty message="No signal data — customer isn't in the latest snapshot." />
      )}
      {signals && (
        <>
          <div
            style={{
              fontFamily: SERIF,
              fontSize: 14,
              color: C.text,
              marginBottom: 4,
              fontStyle: "italic",
            }}
          >
            {signals.reason_one_line || "—"}
          </div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.text2, marginBottom: 14 }}>
            Suggested action: {signals.suggested_action || "Check recent comms."}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
              gap: 10,
            }}
          >
            <SubScore label="We-silent" value={signals.sub_scores.we_silent} />
            <SubScore label="Client-silent" value={signals.sub_scores.client_silent} />
            <SubScore label="Response drop" value={signals.sub_scores.response_drop} />
            <SubScore label="Volume" value={signals.sub_scores.volume_collapse} />
            <SubScore label="Usage" value={signals.sub_scores.usage} />
            <SubScore label="Billing" value={signals.sub_scores.billing} />
          </div>

          <div
            style={{
              marginTop: 14,
              display: "flex",
              gap: 14,
              flexWrap: "wrap",
              fontFamily: SANS,
              fontSize: 11,
              color: C.text3,
            }}
          >
            {signals.last_in_iso && <span>Last in: {fmtDate(signals.last_in_iso)}</span>}
            {signals.last_out_iso && <span>Last out: {fmtDate(signals.last_out_iso)}</span>}
            {signals.lifecycle_state && (
              <span>Lifecycle: {signals.lifecycle_state.replace(/_/g, " ")}</span>
            )}
            <span>Trajectory · {signals.trajectory_7d}</span>
          </div>
        </>
      )}
    </Card>
  );
}

function SubScore({ label, value }: { label: string; value: number }) {
  const accent = value >= 65 ? C.ember : value >= 35 ? C.brass : C.patina;
  return (
    <div
      style={{
        background: "#F0E4CC",
        border: "1px solid " + C.border,
        borderRadius: 8,
        padding: "8px 10px",
      }}
    >
      <div style={{ fontFamily: SANS, fontSize: 10, color: C.text3, letterSpacing: "0.05em", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 500, color: accent, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
 * Section: Performance (Performance Beacon)
 * ───────────────────────────────────────────────────────────────*/
function PerformanceSection({
  performance,
  error,
  entityId,
}: {
  performance: PerformanceBlock | null;
  error?: string;
  entityId: string;
}) {
  return (
    <Card
      title="Performance"
      accent={C.brass}
      rightSlot={
        <Link
          href={`/performance/report/${entityId}`}
          style={{ fontFamily: SANS, fontSize: 12, color: C.brass, textDecoration: "none", fontWeight: 500 }}
        >
          Full report →
        </Link>
      }
    >
      {error && <ErrorRow error={error} />}
      {!error && !performance && (
        <Empty message="No Performance data — customer isn't onboarded into Performance Beacon yet." />
      )}
      {performance && (
        <>
          <div
            style={{
              fontFamily: SANS,
              fontSize: 12,
              color: C.text2,
              marginBottom: 12,
            }}
          >
            {performance.vertical}
            {performance.city && ` · ${performance.city}`}
            {performance.state && `, ${performance.state}`}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 10,
            }}
          >
            <Tile
              label="YTD leads"
              value={performance.ytd_leads.toLocaleString()}
              accent={C.brass}
            />
            <Tile
              label="Predicted 6mo"
              value={
                performance.predicted_6_month_leads !== null
                  ? performance.predicted_6_month_leads.toLocaleString()
                  : "—"
              }
              accent={C.lapis}
            />
            <Tile
              label="Active keywords"
              value={`${performance.active_keywords_count}`}
              accent={C.patina}
              sub={`${performance.top3_keywords_count} top-3 · ${performance.top10_keywords_count} top-10`}
            />
            <Tile
              label="Peak GBP clicks"
              value={
                performance.peak_month_clicks !== null
                  ? performance.peak_month_clicks.toLocaleString()
                  : "—"
              }
              accent={C.text}
              sub={performance.peak_month ? fmtMonth(performance.peak_month) : undefined}
            />
            <Tile
              label="Current GBP clicks"
              value={
                performance.current_month_clicks !== null
                  ? performance.current_month_clicks.toLocaleString()
                  : "—"
              }
              accent={
                performance.dip_pct_complete_months !== null && performance.dip_pct_complete_months >= 25
                  ? C.ember
                  : C.text
              }
              sub={performance.current_month ? `${fmtMonth(performance.current_month)} · partial` : undefined}
            />
            <Tile
              label="Dip vs peak"
              value={
                performance.dip_pct_complete_months !== null
                  ? `${performance.dip_pct_complete_months}%`
                  : "—"
              }
              accent={
                performance.dip_pct_complete_months !== null && performance.dip_pct_complete_months >= 25
                  ? C.ember
                  : C.text3
              }
              sub="complete months"
            />
          </div>
        </>
      )}
    </Card>
  );
}

function Tile({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: string;
  accent: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        background: "#F0E4CC",
        border: "1px solid " + C.border,
        borderRadius: 8,
        padding: "10px 12px",
      }}
    >
      <div style={{ fontFamily: SANS, fontSize: 10, color: C.text3, letterSpacing: "0.05em", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 500, color: accent, marginTop: 2 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontFamily: SANS, fontSize: 10, color: C.text3, marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
 * Section: Escalations
 * ───────────────────────────────────────────────────────────────*/
function EscalationSection({
  escalation,
  error,
  bizName,
}: {
  escalation: EscalationBlock | null;
  error?: string;
  bizName: string;
}) {
  return (
    <Card
      title="Escalations"
      accent={C.crimson}
      rightSlot={
        <Link
          href={`/escalation?q=${encodeURIComponent(bizName)}`}
          style={{ fontFamily: SANS, fontSize: 12, color: C.crimson, textDecoration: "none", fontWeight: 500 }}
        >
          Open in Escalation →
        </Link>
      }
    >
      {error && <ErrorRow error={error} />}
      {!error && !escalation && (
        <Empty message="No ticket data available." />
      )}
      {escalation && (
        <>
          <div
            style={{
              display: "flex",
              gap: 18,
              fontFamily: SANS,
              fontSize: 12,
              color: C.text2,
              marginBottom: 12,
              flexWrap: "wrap",
            }}
          >
            <span><strong style={{ color: C.crimson }}>{escalation.open_count}</strong> open</span>
            <span><strong>{escalation.closed_30d_count}</strong> closed in last 30d</span>
          </div>

          {escalation.open_recent.length === 0 ? (
            <Empty message="No open tickets — calm waters." />
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {escalation.open_recent.map((t) => (
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
                        {t.state} ·{" "}
                        {t.age_days === 0
                          ? "today"
                          : t.age_days === 1
                          ? "1 day ago"
                          : `${t.age_days} days ago`}
                      </div>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

/* ───────────────────────────────────────────────────────────────
 * Section: Post-Payment Reviews
 * ───────────────────────────────────────────────────────────────*/
function PostPaymentSection({
  postPayment,
  error,
  cbCustomerId,
}: {
  postPayment: PostPaymentBlock | null;
  error?: string;
  cbCustomerId: string | null;
}) {
  return (
    <Card
      title="Post-Payment Review"
      accent={C.patina}
      rightSlot={
        cbCustomerId ? (
          <Link
            href={`/post-payment/reports/${cbCustomerId}`}
            style={{ fontFamily: SANS, fontSize: 12, color: C.patina, textDecoration: "none", fontWeight: 500 }}
          >
            Open report →
          </Link>
        ) : null
      }
    >
      {error && <ErrorRow error={error} />}
      {!error && !postPayment && (
        <Empty message="Customer hasn't been through the Post-Payment ICP analysis. Most book customers haven't — only new customers since the floor date run through it." />
      )}
      {postPayment && (
        <>
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
              marginBottom: 10,
            }}
          >
            {postPayment.verdict && (
              <span
                style={{
                  fontFamily: SANS,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "4px 12px",
                  borderRadius: 999,
                  background:
                    postPayment.verdict === "icp"
                      ? `${C.patina}15`
                      : postPayment.verdict === "review"
                      ? `${C.brass}15`
                      : `${C.ember}15`,
                  color:
                    postPayment.verdict === "icp"
                      ? C.patina
                      : postPayment.verdict === "review"
                      ? C.brass
                      : C.ember,
                }}
              >
                {postPayment.verdict === "icp"
                  ? "ICP"
                  : postPayment.verdict === "review"
                  ? "Review"
                  : "Not ICP"}
              </span>
            )}
            {postPayment.needs_am_call && (
              <span
                style={{
                  fontFamily: SANS,
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "3px 10px",
                  borderRadius: 999,
                  background: `${C.crimson}15`,
                  color: C.crimson,
                }}
              >
                Needs AM call
              </span>
            )}
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.text3 }}>
              status: {postPayment.status}
            </span>
          </div>

          {postPayment.verdict_one_line && (
            <div
              style={{
                fontFamily: SERIF,
                fontSize: 14,
                fontStyle: "italic",
                color: C.text,
                marginBottom: 8,
              }}
            >
              “{postPayment.verdict_one_line}”
            </div>
          )}

          {postPayment.key_flags && postPayment.key_flags.length > 0 && (
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                marginBottom: 8,
              }}
            >
              {postPayment.key_flags.slice(0, 6).map((f, i) => (
                <span
                  key={i}
                  style={{
                    fontFamily: SANS,
                    fontSize: 11,
                    color: C.text2,
                    background: "#F0E4CC",
                    border: "1px solid " + C.border,
                    borderRadius: 4,
                    padding: "2px 8px",
                  }}
                >
                  {f}
                </span>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 6 }}>
            {postPayment.report_docx_url && (
              <a
                href={postPayment.report_docx_url}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontFamily: SANS,
                  fontSize: 12,
                  color: C.patina,
                  textDecoration: "none",
                  fontWeight: 500,
                }}
              >
                Open analysis (.docx) →
              </a>
            )}
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.text3 }}>
              Analyzed {fmtDate(postPayment.updated_at)}
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

/* ───────────────────────────────────────────────────────────────
 * Helpers
 * ───────────────────────────────────────────────────────────────*/

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      new Date(t).getUTCFullYear() === new Date().getUTCFullYear() ? undefined : "numeric",
  });
}

function fmtMonth(monthIso: string): string {
  const t = Date.parse(monthIso);
  if (!Number.isFinite(t)) return monthIso;
  return new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function SkeletonHero() {
  return (
    <div
      style={{
        background: C.surface,
        border: "1px solid " + C.border,
        borderRadius: 16,
        padding: "20px 24px",
        marginBottom: 16,
        height: 140,
        opacity: 0.5,
      }}
    />
  );
}

function SkeletonSection() {
  return (
    <div
      style={{
        background: C.surface,
        border: "1px solid " + C.border,
        borderRadius: 14,
        padding: "16px 20px",
        marginBottom: 12,
        height: 120,
        opacity: 0.4,
      }}
    />
  );
}

/* ───────────────────────────────────────────────────────────────
 * Phase E-18 — comms perspective panel
 * Fetches /api/customer/perspective/{entityId}. The GET endpoint is
 * read-through cache: if today's row is missing it triggers Haiku +
 * persists. From the AM's perspective this means the FIRST visit
 * lights up the panel; subsequent visits are instant.
 * ───────────────────────────────────────────────────────────────*/

interface PerspectiveResponse {
  ok: boolean;
  perspective?: {
    entity_id: string;
    snapshot_date: string;
    message_count: number;
    channel_mix: Record<string, number>;
    direction_mix: { inbound: number; outbound: number; system: number };
    sentiment: "warm" | "neutral" | "tense" | "escalating";
    sentiment_evidence: Array<{ snippet: string; source_id: string; why: string }>;
    topics: string[];
    substance_score: number;
    initiator_pattern: "mostly_us" | "mostly_them" | "balanced";
    response_latency_hours: number | null;
    conversation_arcs: Array<{
      start_iso: string;
      peak_iso: string;
      end_iso: string;
      topic: string;
      resolved: boolean;
    }>;
    haiku_summary: string;
    computed_at: string;
  };
  error?: string;
}

const SENTIMENT_ACCENT: Record<
  "warm" | "neutral" | "tense" | "escalating",
  string
> = {
  warm: C.patina,
  neutral: C.text2,
  tense: C.ember,
  escalating: C.crimson,
};

function CommsPerspectivePanel({ entityId }: { entityId: string }) {
  const [resp, setResp] = useState<PerspectiveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/customer/perspective/${encodeURIComponent(entityId)}`,
          { cache: "no-store" },
        );
        const json = (await r.json()) as PerspectiveResponse;
        if (!cancelled) setResp(json);
      } catch (e) {
        if (!cancelled) setResp({ ok: false, error: String(e) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityId]);

  return (
    <Card title="Comms perspective" accent={C.lapis}>
      {loading && (
        <div style={{ fontFamily: SANS, fontSize: 12, color: C.text3 }}>
          Generating Haiku perspective from the last 90 days of comms…
        </div>
      )}
      {!loading && (!resp || !resp.ok || !resp.perspective) && (
        <Empty
          message={
            resp?.error
              ? `Couldn't load perspective: ${resp.error}`
              : "No comms perspective available yet."
          }
        />
      )}
      {!loading && resp?.ok && resp.perspective && (
        <PerspectiveBody perspective={resp.perspective} />
      )}
    </Card>
  );
}

function PerspectiveBody({
  perspective: p,
}: {
  perspective: NonNullable<PerspectiveResponse["perspective"]>;
}) {
  const accent = SENTIMENT_ACCENT[p.sentiment];
  return (
    <>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <span
          style={{
            fontFamily: SANS,
            fontSize: 12,
            fontWeight: 600,
            padding: "4px 12px",
            borderRadius: 999,
            background: `${accent}1F`,
            color: accent,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          {p.sentiment}
        </span>
        <span style={{ fontFamily: SANS, fontSize: 12, color: C.text2 }}>
          {p.message_count} messages · {p.initiator_pattern.replace(/_/g, " ")}
          {p.response_latency_hours !== null
            ? ` · median reply ${p.response_latency_hours}h`
            : ""}
        </span>
      </div>

      {p.topics.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginBottom: 12,
          }}
        >
          {p.topics.map((t) => (
            <span
              key={t}
              style={{
                fontFamily: SANS,
                fontSize: 11,
                color: C.text2,
                background: "#F0E4CC",
                border: "1px solid " + C.border,
                borderRadius: 4,
                padding: "2px 8px",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {/* Substance gauge — simple bar */}
      <div style={{ marginBottom: 12 }}>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 11,
            color: C.text3,
            marginBottom: 4,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          Substance · {p.substance_score}/100
        </div>
        <div
          style={{
            height: 6,
            background: "#F0E4CC",
            borderRadius: 3,
            overflow: "hidden",
            border: "1px solid " + C.border,
          }}
        >
          <div
            style={{
              width: `${Math.max(0, Math.min(100, p.substance_score))}%`,
              height: "100%",
              background: accent,
            }}
          />
        </div>
      </div>

      <p
        style={{
          fontFamily: SERIF,
          fontSize: 14,
          fontStyle: "italic",
          color: C.text,
          margin: "0 0 12px",
          lineHeight: 1.5,
        }}
      >
        {p.haiku_summary}
      </p>

      {p.conversation_arcs.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 8,
          }}
        >
          <div
            style={{
              fontFamily: SANS,
              fontSize: 11,
              color: C.text3,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            Recent conversation arcs
          </div>
          {p.conversation_arcs.map((arc, i) => (
            <div
              key={i}
              style={{
                fontFamily: SANS,
                fontSize: 12,
                color: C.text2,
                display: "flex",
                gap: 10,
                alignItems: "center",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: arc.resolved ? C.patina : C.ember,
                }}
                aria-hidden
              />
              <strong style={{ color: C.text }}>{arc.topic}</strong>
              <span style={{ color: C.text3, fontSize: 11 }}>
                {fmtDate(arc.start_iso)} → {fmtDate(arc.end_iso)} ·{" "}
                {arc.resolved ? "resolved" : "open"}
              </span>
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          marginTop: 12,
          fontFamily: SANS,
          fontSize: 10,
          color: C.text3,
        }}
      >
        Computed by Haiku · last refresh{" "}
        {new Date(p.computed_at).toLocaleString()}
      </div>
    </>
  );
}
