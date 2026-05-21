import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchEntityReportData } from "@/lib/report/fetchers";
import { composeReport, fmtMonth } from "@/lib/report/compose";
import type { ComposedReport } from "@/lib/report/compose";
import type { Lead } from "@/lib/report/types";

export const dynamic = "force-dynamic";

// Reference-report visual tokens
const ZOCA_BLUE = "#4472C4";
const TEXT = "#222";
const MUTED = "#666";
const BORDER = "#e0e0e0";
const CALLOUT_INFO = "#e7f0ff";
const CALLOUT_INFO_BORDER = "#4472C4";
const CALLOUT_WARN = "#fff4e6";
const CALLOUT_WARN_BORDER = "#f59f00";
const CALLOUT_OK = "#e6f4ea";
const CALLOUT_OK_BORDER = "#34a853";
const TILE_BG = "#f4f7fc";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ReportPage({
  params,
}: {
  params: { entityId: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }

  const entityId = params.entityId;

  let data;
  try {
    data = await fetchEntityReportData(entityId);
  } catch (err) {
    return <ErrorState entityId={entityId} message={(err as Error).message} />;
  }

  if (!data) {
    return (
      <ErrorState
        entityId={entityId}
        message="No location found for this entity_id in gbp.locations. Double-check the UUID."
      />
    );
  }

  const report = composeReport(data, {});

  return (
    <main
      style={{
        maxWidth: 920,
        margin: "0 auto",
        padding: "32px 24px 64px",
        color: TEXT,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        lineHeight: 1.6,
      }}
    >
      <TopBar entityId={entityId} />
      <Header report={report} />
      <SnapshotTiles report={report} />
      <LeadSourceCallout report={report} />
      <GbpClicksSection report={report} />
      <KeywordRankingsSection report={report} />
      <LeadsSection report={report} />
      <RcaSection report={report} />
      <ActionChecklistSection report={report} />
      <ForecastSection report={report} />
      <GrowthManagerNote report={report} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TopBar({ entityId }: { entityId: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 24,
        paddingBottom: 12,
        borderBottom: `1px solid ${BORDER}`,
      }}
    >
      <a href="/performance" style={{ color: MUTED, textDecoration: "none", fontSize: 13 }}>
        ← Back
      </a>
      <a
        href={`/performance/api/report/${entityId}/docx`}
        style={{
          background: ZOCA_BLUE,
          color: "white",
          textDecoration: "none",
          padding: "8px 16px",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        Download as Word
      </a>
    </div>
  );
}

function Header({ report }: { report: ComposedReport }) {
  const i = report.identity;
  return (
    <header style={{ marginBottom: 28 }}>
      <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600 }}>{i.title}</h1>
      <p style={{ margin: "4px 0 0", color: MUTED }}>
        Local SEO &amp; Growth Performance Report
      </p>
      <p style={{ margin: "10px 0 0", color: MUTED, fontSize: 14 }}>
        Prepared for {i.title} &nbsp;|&nbsp; {report.reportMonth}
        {i.city ? ` · ${i.city}${i.state ? ", " + i.state : ""}` : ""}
      </p>
    </header>
  );
}

// --- Section 2: Snapshot tiles ---------------------------------------------

function SnapshotTiles({ report }: { report: ComposedReport }) {
  const t = report.snapshot;
  const tiles = [
    {
      headline: t.totalGbpLeadsYtd.toString(),
      label: "Total GBP Leads (YTD)",
      sub: "Active pipeline",
    },
    {
      headline: t.bookedLeads.toString(),
      label: "Booked Leads",
      sub: "Confirmed bookings",
    },
    {
      headline:
        t.predicted6MonthRevenue != null
          ? `$${t.predicted6MonthRevenue.toLocaleString()}`
          : "—",
      label: "Predicted 6-Month Revenue",
      sub:
        t.predicted6MonthLeads != null
          ? `${t.predicted6MonthLeads} leads forecast`
          : "Baseline projection",
    },
    {
      headline: t.weeklyReviewTarget != null ? `${t.weeklyReviewTarget} reviews` : "—",
      label: "Weekly Review Target",
      sub: "Per week",
    },
  ];
  return (
    <Section title="Performance snapshot at a glance">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 12,
        }}
      >
        {tiles.map((tile) => (
          <div
            key={tile.label}
            style={{
              background: TILE_BG,
              border: `1px solid ${BORDER}`,
              borderRadius: 8,
              padding: "16px 14px",
            }}
          >
            <div style={{ fontSize: 24, fontWeight: 600, color: ZOCA_BLUE }}>
              {tile.headline}
            </div>
            <div style={{ fontSize: 12, fontWeight: 500, marginTop: 6 }}>
              {tile.label}
            </div>
            <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
              {tile.sub}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// --- Section 3: Lead-source callout ----------------------------------------

function LeadSourceCallout({ report }: { report: ComposedReport }) {
  const top = report.leadSourceMix[0];
  if (!top) return null;
  const isGbp = top.source === "Google Maps GBP";
  const message = isGbp
    ? `${top.pct}% of your recent leads are coming directly from Google Maps GBP — your Zoca-powered profile is your #1 lead engine right now.`
    : `${top.pct}% of your recent leads are coming from ${top.source}.`;
  return (
    <Callout tone="info">
      <strong>📍</strong> {message}
    </Callout>
  );
}

// --- Section 4: GBP Profile Clicks Journey ---------------------------------

function GbpClicksSection({ report }: { report: ComposedReport }) {
  const ct = report.clicksTrend;
  const i = report.identity;
  const start = ct.sampledMonths[0];
  const peak = ct.peak;
  const current = ct.current;

  return (
    <Section title="Google Business Profile — what's working">
      {start && peak && current && (
        <p style={{ margin: "0 0 14px" }}>
          {i.title}'s GBP profile has shown a clear trajectory from{" "}
          <strong>{fmtMonth(start.month)}</strong> through to{" "}
          <strong>{fmtMonth(current.month)}</strong> — peaking at{" "}
          <strong>{peak.clicks.toLocaleString()} profile clicks</strong> in{" "}
          {fmtMonth(peak.month)}. This shows the power of Zoca's local SEO foundation at work.
        </p>
      )}
      {ct.sampledMonths.length > 0 && (
        <table style={tableStyle}>
          <thead>
            <tr>
              <ThCell>Month</ThCell>
              {ct.sampledMonths.map((m) => (
                <ThCell key={m.month}>{fmtMonth(m.month)}</ThCell>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <TdCell strong>Profile clicks</TdCell>
              {ct.sampledMonths.map((m) => (
                <TdCell key={m.month}>
                  ~{m.profileClicks.toLocaleString()}
                  {peak && m.month === peak.month ? " ⭐" : ""}
                </TdCell>
              ))}
            </tr>
          </tbody>
        </table>
      )}
      {ct.dipPct != null && ct.dipPct >= 30 && peak && current && (
        <Callout tone="warn">
          ⚠️ Profile clicks declined {ct.dipPct}% from {fmtMonth(peak.month)} (~
          {peak.clicks.toLocaleString()}) to {fmtMonth(current.month)} (~
          {current.clicks.toLocaleString()}). See the RCA section below.
        </Callout>
      )}
      {ct.dipPct != null && ct.dipPct < 0 && (
        <Callout tone="ok">
          ✅ Profile clicks are holding up well — current month is in line with peak.
        </Callout>
      )}
    </Section>
  );
}

// --- Section 5: Top Keyword Rankings ---------------------------------------

function KeywordRankingsSection({ report }: { report: ComposedReport }) {
  if (!report.keywords.length) return null;
  const wins = report.keywords.filter(
    (k) =>
      k.rankWhenJoined != null &&
      k.rankCurrent != null &&
      k.rankWhenJoined - k.rankCurrent >= 50
  );
  return (
    <Section title="Top keyword rankings">
      <p style={{ margin: "0 0 12px" }}>
        Despite any visibility shifts, your keyword rankings tell a strong story:
      </p>
      <table style={tableStyle}>
        <thead>
          <tr>
            <ThCell>Keyword</ThCell>
            <ThCell>When you joined</ThCell>
            <ThCell>Best rank achieved</ThCell>
            <ThCell>Current rank</ThCell>
          </tr>
        </thead>
        <tbody>
          {report.keywords.slice(0, 10).map((k) => (
            <tr key={k.keyword}>
              <TdCell>{k.keyword}</TdCell>
              <TdCell>{k.rankWhenJoined ?? "—"}</TdCell>
              <TdCell strong>
                {k.rankBest ?? "—"}
                {k.rankBest != null && k.rankBest <= 3 ? " 🏆" : ""}
              </TdCell>
              <TdCell>{k.rankCurrent ?? "—"}</TdCell>
            </tr>
          ))}
        </tbody>
      </table>
      {wins.length > 0 && (
        <Callout tone="ok">
          🏆 Major wins: {wins
            .slice(0, 3)
            .map(
              (w) =>
                `'${w.keyword}' jumped from rank ${w.rankWhenJoined} to ${w.rankCurrent}`
            )
            .join("; ")}.
        </Callout>
      )}
    </Section>
  );
}

// --- Section 6: Leads Analysis ----------------------------------------------

function LeadsSection({ report }: { report: ComposedReport }) {
  const recent = report.leads.slice(0, 12);
  if (!recent.length) return null;
  const unmarked = report.leads.filter((l) => l.status === "UNMARKED").length;
  const total = report.leads.length;
  return (
    <Section
      title={`Leads analysis — ${total} recent leads via Google Maps GBP`}
    >
      <table style={tableStyle}>
        <thead>
          <tr>
            <ThCell>Customer</ThCell>
            <ThCell>Created</ThCell>
            <ThCell>Service</ThCell>
            <ThCell>Status</ThCell>
            <ThCell>Type</ThCell>
          </tr>
        </thead>
        <tbody>
          {recent.map((l) => (
            <tr key={l.id}>
              <TdCell>{customerLabel(l)}</TdCell>
              <TdCell>{shortDate(l.createdAt)}</TdCell>
              <TdCell>
                {l.service || l.serviceVariationName || "(no service)"}
              </TdCell>
              <TdCell>
                <StatusPill status={l.status} />
              </TdCell>
              <TdCell>{l.customerType ?? "—"}</TdCell>
            </tr>
          ))}
        </tbody>
      </table>
      {unmarked > 0 && (
        <Callout tone="warn">
          ⚡ Action required: {unmarked} of {total} leads are currently
          UNMARKED. Update the status of these leads in the Zoca app to improve
          revenue forecast accuracy.
        </Callout>
      )}
    </Section>
  );
}

// --- Section 7: RCA --------------------------------------------------------

function RcaSection({ report }: { report: ComposedReport }) {
  const rca = report.rca;
  return (
    <Section title="RCA update — profile click trend investigation">
      <p style={{ margin: "0 0 12px" }}>
        We track every entity's profile-click trajectory continuously. This
        section gives you the latest read on visibility and what we're acting
        on.
      </p>
      <table style={tableStyle}>
        <tbody>
          <Tr label="Peak month">
            {rca.peak
              ? `${fmtMonth(rca.peak.month)} (~${rca.peak.clicks.toLocaleString()} clicks)`
              : "—"}
          </Tr>
          <Tr label="Current month">
            {rca.current
              ? `${fmtMonth(rca.current.month)} (~${rca.current.clicks.toLocaleString()} clicks)`
              : "—"}
          </Tr>
          <Tr label="Change from peak">
            {rca.dipPct != null
              ? rca.dipPct > 0
                ? `↓ ${rca.dipPct}%`
                : `↑ ${Math.abs(rca.dipPct)}%`
              : "—"}
          </Tr>
          {rca.ticketId && (
            <Tr label="RCA ticket">
              {rca.ticketUrl ? (
                <a href={rca.ticketUrl}>{rca.ticketId}</a>
              ) : (
                rca.ticketId
              )}
              {rca.status ? ` — ${rca.status}` : ""}
            </Tr>
          )}
        </tbody>
      </table>
      {rca.showDipBanner ? (
        <Callout tone="warn">
          ⚠️ A material dip has been detected. The recommended next steps are
          surfaced in the action checklist below — refreshing GBP photos and
          posting an offer typically recover visibility within 2–3 weeks.
        </Callout>
      ) : (
        <Callout tone="ok">
          ✅ Click volume is stable. We continue to monitor for any emerging
          dips and will surface them automatically here.
        </Callout>
      )}
    </Section>
  );
}

// --- Section 8: Action Checklist -------------------------------------------

function ActionChecklistSection({ report }: { report: ComposedReport }) {
  if (!report.actions.length) return null;
  return (
    <Section title={`What you can do right now — action checklist`}>
      {report.actions.map((a, idx) => (
        <article
          key={a.id}
          style={{
            background: "#fafbfd",
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            padding: "16px 18px",
            marginBottom: 12,
          }}
        >
          <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600 }}>
            {idx + 1}. {a.title}
            {a.emphasis === "high_impact" && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  background: CALLOUT_WARN,
                  color: "#a35e00",
                  padding: "2px 8px",
                  borderRadius: 999,
                  fontWeight: 500,
                }}
              >
                High impact
              </span>
            )}
          </h3>
          {a.intro && (
            <p style={{ margin: "6px 0 8px", color: TEXT }}>{a.intro}</p>
          )}
          {a.bullets && (
            <ul style={{ margin: "8px 0", paddingLeft: 22 }}>
              {a.bullets.map((b, i) => (
                <li key={i} style={{ marginBottom: 3 }}>
                  {b}
                </li>
              ))}
            </ul>
          )}
          {a.table && (
            <table style={{ ...tableStyle, marginTop: 10 }}>
              {a.table.caption && (
                <caption
                  style={{
                    captionSide: "top",
                    textAlign: "left",
                    fontSize: 12,
                    color: MUTED,
                    paddingBottom: 4,
                  }}
                >
                  {a.table.caption}
                </caption>
              )}
              <thead>
                <tr>
                  {a.table.headers.map((h) => (
                    <ThCell key={h}>{h}</ThCell>
                  ))}
                </tr>
              </thead>
              <tbody>
                {a.table.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((c, j) => (
                      <TdCell key={j}>{c}</TdCell>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {a.closing && (
            <p style={{ margin: "8px 0 0", color: TEXT }}>{a.closing}</p>
          )}
          <p
            style={{
              margin: "10px 0 0",
              fontSize: 11,
              color: MUTED,
              fontStyle: "italic",
            }}
            title="Why this action was selected"
          >
            Why this is here: {a.rationale}
          </p>
        </article>
      ))}
    </Section>
  );
}

// --- Section 9: Forecast ---------------------------------------------------

function ForecastSection({ report }: { report: ComposedReport }) {
  const f = report.forecast;
  if (!f) return null;
  return (
    <Section title="6-month forecast">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 12,
        }}
      >
        <Tile
          headline={f.predicted6MonthLeads?.toString() ?? "—"}
          label="Projected leads (6 months)"
          sub={`+${
            f.predicted6MonthLeads ? Math.round(f.predicted6MonthLeads / 26) : "?"
          } per week target`}
        />
        <Tile
          headline={
            f.predicted6MonthRevenue != null
              ? `$${f.predicted6MonthRevenue.toLocaleString()}`
              : "—"
          }
          label="Predicted revenue"
          sub="Baseline projection"
        />
        <Tile
          headline={
            f.percentageChangeProfileClicks != null
              ? `${f.percentageChangeProfileClicks > 0 ? "+" : ""}${f.percentageChangeProfileClicks}%`
              : "—"
          }
          label="Predicted click change"
          sub="Versus without-Zoca baseline"
        />
      </div>
      <Callout tone="info">
        💡 Following up on every incoming lead and updating their status in the
        Zoca app helps the algorithm produce more accurate (and higher) forecasts.
      </Callout>
    </Section>
  );
}

// --- Section 10: Growth Manager Note ---------------------------------------

function GrowthManagerNote({ report }: { report: ComposedReport }) {
  return (
    <Section title="A note from your Growth Manager">
      <p>Hi {report.identity.title} team,</p>
      <p>
        Thanks for being an active member of the Zoca family. The traction
        you've built so far shows there's a strong market for what you offer in{" "}
        {report.identity.city ?? "your area"}.
        {report.rca.showDipBanner
          ? " The current dip is something we take seriously — please give the action checklist above your attention this week."
          : " Keep up the steady work — and use the action checklist above to compound the lead pipeline week over week."}
      </p>
      <p>
        The single biggest things you can do this week are at the top of the
        checklist. Reach out anytime.
      </p>
      <p style={{ marginTop: 16, fontWeight: 500 }}>
        {report.growthManagerName}
        <br />
        <span style={{ fontWeight: 400, color: MUTED }}>
          Senior Growth Manager, Zoca
        </span>
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Tiny presentational helpers
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2
        style={{
          margin: "0 0 12px",
          fontSize: 18,
          fontWeight: 600,
          paddingBottom: 6,
          borderBottom: `2px solid ${ZOCA_BLUE}`,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Callout({
  tone,
  children,
}: {
  tone: "info" | "warn" | "ok";
  children: React.ReactNode;
}) {
  const palette = {
    info: { bg: CALLOUT_INFO, border: CALLOUT_INFO_BORDER },
    warn: { bg: CALLOUT_WARN, border: CALLOUT_WARN_BORDER },
    ok: { bg: CALLOUT_OK, border: CALLOUT_OK_BORDER },
  }[tone];
  return (
    <div
      style={{
        marginTop: 12,
        background: palette.bg,
        borderLeft: `4px solid ${palette.border}`,
        padding: "10px 14px",
        borderRadius: 4,
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function Tile({
  headline,
  label,
  sub,
}: {
  headline: string;
  label: string;
  sub: string;
}) {
  return (
    <div
      style={{
        background: TILE_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        padding: "16px 14px",
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 600, color: ZOCA_BLUE }}>
        {headline}
      </div>
      <div style={{ fontSize: 12, fontWeight: 500, marginTop: 6 }}>{label}</div>
      <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
  marginTop: 4,
};

function ThCell({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        background: ZOCA_BLUE,
        color: "white",
        textAlign: "left",
        padding: "8px 10px",
        fontWeight: 500,
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function TdCell({
  children,
  strong,
}: {
  children: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <td
      style={{
        padding: "8px 10px",
        borderBottom: `1px solid ${BORDER}`,
        verticalAlign: "top",
        fontWeight: strong ? 500 : 400,
      }}
    >
      {children}
    </td>
  );
}

function Tr({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <TdCell strong>{label}</TdCell>
      <TdCell>{children}</TdCell>
    </tr>
  );
}

function StatusPill({ status }: { status: string }) {
  const palette: Record<string, { bg: string; fg: string }> = {
    BOOKED: { bg: "#e6f4ea", fg: "#137333" },
    UNMARKED: { bg: "#fff4e6", fg: "#a35e00" },
    CONTACTED: { bg: CALLOUT_INFO, fg: "#1a4ea8" },
    NOT_INTERESTED: { bg: "#fce4e4", fg: "#a31a1a" },
    FOLLOW_UP: { bg: "#e7f0ff", fg: "#1a4ea8" },
  };
  const c = palette[status] ?? { bg: "#eee", fg: "#444" };
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        fontSize: 11,
        fontWeight: 500,
        padding: "2px 8px",
        borderRadius: 999,
      }}
    >
      {status}
    </span>
  );
}

function customerLabel(l: Lead): string {
  const name = [l.firstName, l.lastName].filter(Boolean).join(" ").trim();
  return name || l.email || l.phone || l.id.slice(0, 8);
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

function ErrorState({
  entityId,
  message,
}: {
  entityId: string;
  message: string;
}) {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "48px 24px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <a href="/performance" style={{ color: MUTED, textDecoration: "none", fontSize: 13 }}>
        ← Back
      </a>
      <h1 style={{ marginTop: 24, fontSize: 22 }}>Could not generate report</h1>
      <p>
        Tried to load entity <code>{entityId}</code> but ran into:
      </p>
      <pre
        style={{
          background: "#fce4e4",
          color: "#a31a1a",
          padding: 12,
          borderRadius: 6,
          fontSize: 13,
          whiteSpace: "pre-wrap",
        }}
      >
        {message}
      </pre>
    </main>
  );
}
