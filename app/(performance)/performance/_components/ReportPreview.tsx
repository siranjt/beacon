import type { ComposedReport } from "@/lib/report/compose";
import type { GbpMonthlyClicks } from "@/lib/report/types";

const SERIF = 'Georgia, "Times New Roman", "Times", serif';
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif";

// Watchfire palette
const BRASS = "#D9A441";
const BRASS_DEEP = "#B8852E";
const BRASS_SOFT = "#F5E6BB";
const EMBER = "#C8431D";
const EMBER_SOFT = "#FCE4D6";
const PATINA = "#4A7C59";
const PATINA_DEEP = "#2D4843";
const PATINA_SOFT = "#DAE5DC";
const LAPIS = "#2A4D5C";
const TEXT = "#2B1F14";
const MUTED = "#6E5F50";
const FADED = "#8B7A66";
const BORDER = "#D4C29B";
const SURFACE = "#F8EFD7";
const SURFACE_TINT = "#EBE0C2";

/**
 * The full report rendered as the card-grid layout with charts.
 *
 * Replaces the old long-form Word-document layout. Used on both:
 *  - /performance/report/[entityId] (full screen)
 *  - /performance (inline preview, when implemented)
 *
 * All visuals use Watchfire tokens to match the Beacon umbrella's register.
 */
export default function ReportPreview({ report }: { report: ComposedReport }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        fontFamily: SERIF,
        color: TEXT,
      }}
    >
      {/* 2-up: Snapshot + Lead Source Mix */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
        className="pp-fade-in-up"
      >
        <SnapshotCard report={report} />
        <LeadSourceMixCard report={report} />
      </div>

      {/* Profile Clicks 18-month trajectory */}
      <div className="pp-fade-in-up" style={{ animationDelay: "80ms" }}>
        <ProfileClicksCard report={report} />
      </div>

      {/* Top Keyword Rankings */}
      <div className="pp-fade-in-up" style={{ animationDelay: "160ms" }}>
        <KeywordRankingsCard report={report} />
      </div>

      {/* Action Checklist */}
      <div className="pp-fade-in-up" style={{ animationDelay: "240ms" }}>
        <ActionChecklistCard report={report} />
      </div>

      {/* RCA + Forecast — collapsed to bottom for the dashboard layout */}
      {report.rca.showDipBanner && (
        <div className="pp-fade-in-up" style={{ animationDelay: "320ms" }}>
          <RcaNote report={report} />
        </div>
      )}
      {report.forecast && (
        <div className="pp-fade-in-up" style={{ animationDelay: "400ms" }}>
          <ForecastNote report={report} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card primitives
// ---------------------------------------------------------------------------

function Card({
  children,
  eyebrow,
  badge,
  badgeTone = "brass",
}: {
  children: React.ReactNode;
  eyebrow: string;
  badge?: string;
  badgeTone?: "brass" | "ember" | "patina";
}) {
  const badgeStyles =
    badgeTone === "ember"
      ? { bg: EMBER_SOFT, fg: "#7C2D12" }
      : badgeTone === "patina"
      ? { bg: PATINA_SOFT, fg: PATINA_DEEP }
      : { bg: BRASS_SOFT, fg: BRASS_DEEP };
  return (
    <div
      style={{
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 10,
            letterSpacing: "0.14em",
            color: MUTED,
            fontWeight: 600,
            textTransform: "uppercase",
          }}
        >
          {eyebrow}
        </div>
        {badge && (
          <div
            style={{
              fontFamily: SANS,
              fontSize: 10,
              padding: "2px 8px",
              background: badgeStyles.bg,
              color: badgeStyles.fg,
              borderRadius: 999,
              fontWeight: 600,
              letterSpacing: "0.02em",
            }}
          >
            {badge}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snapshot card — YTD GBP leads + mini area chart of monthly volume
// ---------------------------------------------------------------------------

function SnapshotCard({ report }: { report: ComposedReport }) {
  const t = report.snapshot;
  // Group YTD GBP leads by month for the mini area chart.
  const monthly = monthlyGbpLeadCounts(report);
  const gbpPct = report.leadSourceMix.find((s) => s.source === "Google Maps GBP")?.pct ?? 0;
  return (
    <Card eyebrow="Snapshot" badge={`${gbpPct}% GBP`}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginTop: 10,
        }}
      >
        <div style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 600 }}>
          GBP leads (YTD)
        </div>
        <div
          style={{
            fontFamily: SERIF,
            fontSize: 30,
            fontWeight: 500,
            color: BRASS_DEEP,
            letterSpacing: "-0.01em",
          }}
        >
          {t.totalGbpLeadsYtd}
        </div>
      </div>
      <MiniArea data={monthly} />
      <div
        style={{
          marginTop: 8,
          display: "flex",
          justifyContent: "space-between",
          fontFamily: SANS,
          fontSize: 11,
          color: FADED,
        }}
      >
        <span>{t.bookedLeads} booked</span>
        {t.weeklyReviewTarget != null && <span>Review target {t.weeklyReviewTarget}/wk</span>}
      </div>
    </Card>
  );
}

function MiniArea({ data }: { data: { month: string; count: number }[] }) {
  if (!data.length) {
    return (
      <div
        style={{
          height: 50,
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: SANS,
          fontSize: 11,
          color: FADED,
        }}
      >
        No leads in window
      </div>
    );
  }
  const w = 280;
  const h = 60;
  const maxCount = Math.max(...data.map((d) => d.count), 1);
  const step = w / Math.max(data.length - 1, 1);
  const points = data.map((d, i) => ({
    x: i * step,
    y: h - 4 - (d.count / maxCount) * (h - 12),
  }));
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const fillPath = `${linePath} L ${w},${h} L 0,${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: "100%", height: 50, marginTop: 8, display: "block" }}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="brass-fill-mini" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={BRASS} stopOpacity={0.45} />
          <stop offset="100%" stopColor={BRASS} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={fillPath} fill="url(#brass-fill-mini)" />
      <path
        d={linePath}
        fill="none"
        stroke={BRASS_DEEP}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        pathLength={100}
        className="pp-draw-line"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Lead source mix card — donut + legend
// ---------------------------------------------------------------------------

const DONUT_PALETTE = [BRASS, EMBER, PATINA, LAPIS, "#7C2D12", "#8B7A66"];

function LeadSourceMixCard({ report }: { report: ComposedReport }) {
  const mix = report.leadSourceMix.slice(0, 5);
  const top = mix[0];
  if (!mix.length) {
    return (
      <Card eyebrow="Lead source mix">
        <div style={{ marginTop: 10, fontFamily: SERIF, fontSize: 14 }}>No leads to attribute yet.</div>
      </Card>
    );
  }
  return (
    <Card eyebrow="Lead source mix" badge={`${top.pct}% top`}>
      <div style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 600, marginTop: 10 }}>
        Where the bookings come from
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 10 }}>
        <Donut
          slices={mix.map((m, i) => ({
            color: DONUT_PALETTE[i % DONUT_PALETTE.length],
            pct: m.pct,
          }))}
        />
        <div style={{ flex: 1, fontFamily: SANS, fontSize: 11, color: TEXT }}>
          {mix.map((m, i) => (
            <div
              key={m.source}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "2px 0",
              }}
            >
              <span>
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: DONUT_PALETTE[i % DONUT_PALETTE.length],
                    marginRight: 6,
                  }}
                />
                {m.source}
              </span>
              <span style={{ color: MUTED }}>{m.pct}%</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function Donut({ slices }: { slices: { color: string; pct: number }[] }) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <svg viewBox="0 0 60 60" style={{ width: 80, height: 80, flexShrink: 0 }}>
      <circle cx={30} cy={30} r={radius} fill="none" stroke={SURFACE_TINT} strokeWidth={10} />
      <g className="pp-donut-in">
        {slices.map((s, i) => {
          const dashLen = (s.pct / 100) * circumference;
          const arc = (
            <circle
              key={i}
              cx={30}
              cy={30}
              r={radius}
              fill="none"
              stroke={s.color}
              strokeWidth={10}
              strokeDasharray={`${dashLen.toFixed(2)} ${circumference.toFixed(2)}`}
              strokeDashoffset={(-offset).toFixed(2)}
              transform="rotate(-90 30 30)"
            />
          );
          offset += dashLen;
          return arc;
        })}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Profile clicks — 18-month trajectory with peak indicator
// ---------------------------------------------------------------------------

function ProfileClicksCard({ report }: { report: ComposedReport }) {
  const months = report.data.gbpClicks;
  const ct = report.clicksTrend;
  const dipBadge =
    ct.dipPct != null && ct.dipPct >= 30
      ? { text: `${ct.dipPct}% dip`, tone: "ember" as const }
      : ct.dipPct != null && ct.dipPct < 0
      ? { text: "stable", tone: "patina" as const }
      : undefined;
  const peakLabel = ct.peak ? `peak ~${ct.peak.clicks.toLocaleString()}` : "no peak yet";
  return (
    <Card
      eyebrow="Profile clicks · last 18 months"
      badge={dipBadge?.text}
      badgeTone={dipBadge?.tone}
    >
      <div style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 600, marginTop: 6 }}>
        Trajectory · {peakLabel}
      </div>
      <TrajectoryChart months={months} />
    </Card>
  );
}

function TrajectoryChart({ months }: { months: GbpMonthlyClicks[] }) {
  if (!months.length) {
    return (
      <div
        style={{
          height: 100,
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: SANS,
          fontSize: 11,
          color: FADED,
        }}
      >
        No GBP clicks data
      </div>
    );
  }
  const w = 620;
  const h = 110;
  const data = months.slice(-18);
  const maxClicks = Math.max(...data.map((m) => m.profileClicks), 1);
  const peakIdx = data.indexOf(
    data.reduce((a, b) => (b.profileClicks > a.profileClicks ? b : a))
  );
  const step = w / Math.max(data.length - 1, 1);
  const pts = data.map((m, i) => ({
    x: i * step,
    y: h - 8 - (m.profileClicks / maxClicks) * (h - 20),
  }));
  const linePath = pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const fillPath = `${linePath} L ${w},${h} L 0,${h} Z`;
  const peak = pts[peakIdx];
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: "100%", height: 100, marginTop: 8, display: "block" }}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="brass-fill-traj" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={BRASS} stopOpacity={0.35} />
          <stop offset="100%" stopColor={BRASS} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={fillPath} fill="url(#brass-fill-traj)" />
      <path
        d={linePath}
        fill="none"
        stroke={BRASS_DEEP}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        pathLength={100}
        className="pp-draw-line"
      />
      <circle
        cx={peak.x}
        cy={peak.y}
        r={5}
        fill={EMBER}
        stroke={SURFACE}
        strokeWidth={2}
        className="pp-peak-pulse"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Keyword rankings card — gradient bars
// ---------------------------------------------------------------------------

function KeywordRankingsCard({ report }: { report: ComposedReport }) {
  const all = report.keywords.slice(0, 10);
  if (!all.length) {
    return (
      <Card eyebrow="Top keyword rankings">
        <div style={{ marginTop: 10, fontFamily: SERIF, fontSize: 14 }}>No keyword data yet.</div>
      </Card>
    );
  }
  const top3 = all.filter((k) => (k.rankBest ?? 999) <= 3).length;
  return (
    <Card eyebrow="Top keyword rankings" badge={`${top3} at #1–3`} badgeTone="patina">
      <div style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 600, marginTop: 6 }}>
        Best position achieved
      </div>
      <div style={{ marginTop: 10 }}>
        {all.map((k, idx) => {
          const rank = k.rankBest ?? 100;
          // Bar fills proportional to inverse rank — #1 ≈ 98%, #50 ≈ 50%, #100 ≈ 5%.
          const width = Math.max(8, Math.min(98, 100 - (rank - 1) * 1.0));
          return (
            <div
              key={`${k.keyword}-${idx}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "5px 0",
                fontFamily: SANS,
                fontSize: 12,
                borderTop: idx === 0 ? undefined : `1px solid ${SURFACE_TINT}`,
              }}
            >
              <div
                style={{
                  flex: "0 0 38%",
                  color: TEXT,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={k.keyword}
              >
                {k.keyword}
              </div>
              <div
                style={{
                  flex: 1,
                  height: 8,
                  background: SURFACE_TINT,
                  borderRadius: 999,
                  overflow: "hidden",
                }}
              >
                <div
                  className="pp-fill-bar"
                  style={{
                    height: "100%",
                    width: `${width.toFixed(0)}%`,
                    background: `linear-gradient(90deg, ${EMBER} 0%, ${BRASS} 100%)`,
                    borderRadius: 999,
                    animationDelay: `${0.2 + idx * 0.08}s`,
                  }}
                />
              </div>
              <div
                style={{
                  flex: "0 0 38px",
                  color: BRASS_DEEP,
                  fontWeight: 600,
                  textAlign: "right",
                }}
              >
                {k.rankBest != null ? `#${k.rankBest}` : "—"}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Action checklist card
// ---------------------------------------------------------------------------

function ActionChecklistCard({ report }: { report: ComposedReport }) {
  const actions = report.actions.slice(0, 6);
  if (!actions.length) return null;
  return (
    <Card eyebrow="Action checklist" badge={`${actions.length} actions`}>
      <div style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 600, marginTop: 6 }}>
        Audit-driven
      </div>
      <div style={{ marginTop: 10 }}>
        {actions.map((a, idx) => (
          <div
            key={a.id}
            style={{
              display: "flex",
              gap: 10,
              padding: "8px 0",
              alignItems: "flex-start",
              borderTop: idx === 0 ? undefined : `1px solid ${SURFACE_TINT}`,
            }}
          >
            <div
              style={{
                flex: "0 0 22px",
                height: 22,
                borderRadius: 6,
                background: BRASS_SOFT,
                border: `1px solid ${BRASS}`,
                color: BRASS_DEEP,
                fontFamily: SANS,
                fontSize: 12,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {idx + 1}
            </div>
            <div style={{ flex: 1, fontFamily: SANS, fontSize: 12 }}>
              <div style={{ color: TEXT, fontWeight: 600 }}>
                {a.title}
                {a.emphasis === "high_impact" && (
                  <span
                    style={{
                      marginLeft: 8,
                      color: BRASS_DEEP,
                      fontWeight: 500,
                      fontSize: 11,
                    }}
                  >
                    (high impact)
                  </span>
                )}
              </div>
              {a.intro && (
                <div style={{ color: MUTED, marginTop: 3, lineHeight: 1.5 }}>{a.intro}</div>
              )}
              <div
                style={{
                  color: FADED,
                  marginTop: 4,
                  fontSize: 11,
                  fontStyle: "italic",
                }}
              >
                Why: {a.rationale}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// RCA note + Forecast note — supplementary cards
// ---------------------------------------------------------------------------

function RcaNote({ report }: { report: ComposedReport }) {
  const rca = report.rca;
  if (!rca.peak || !rca.current) return null;
  return (
    <Card eyebrow="RCA · profile click dip" badge="active" badgeTone="ember">
      <div style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 600, marginTop: 6 }}>
        Peak {rca.peak.clicks.toLocaleString()} → current {rca.current.clicks.toLocaleString()} ({rca.dipPct}% drop)
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12, color: MUTED, marginTop: 6, lineHeight: 1.5 }}>
        Recommended next steps are surfaced in the action checklist above. Fresh photos and an
        offer post typically recover visibility within 2–3 weeks.
      </div>
    </Card>
  );
}

function ForecastNote({ report }: { report: ComposedReport }) {
  const f = report.forecast;
  if (!f) return null;
  return (
    <Card eyebrow="6-month forecast">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
          marginTop: 10,
        }}
      >
        <ForecastTile
          headline={f.predicted6MonthLeads?.toString() ?? "—"}
          label="Projected leads"
          sub="Next 6 months"
        />
        <ForecastTile
          headline={
            f.predicted6MonthRevenue != null
              ? `$${f.predicted6MonthRevenue.toLocaleString()}`
              : "—"
          }
          label="Predicted revenue"
          sub="Baseline projection"
        />
        <ForecastTile
          headline={
            f.percentageChangeProfileClicks != null
              ? `${f.percentageChangeProfileClicks > 0 ? "+" : ""}${f.percentageChangeProfileClicks}%`
              : "—"
          }
          label="Click change"
          sub="Versus baseline"
        />
      </div>
    </Card>
  );
}

function ForecastTile({
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
        background: SURFACE_TINT,
        border: `1px solid ${BORDER}`,
        borderRadius: 10,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          fontFamily: SERIF,
          fontSize: 22,
          fontWeight: 500,
          color: BRASS_DEEP,
          letterSpacing: "-0.01em",
        }}
      >
        {headline}
      </div>
      <div
        style={{
          fontFamily: SANS,
          fontSize: 11,
          fontWeight: 600,
          marginTop: 4,
          color: TEXT,
          letterSpacing: "0.02em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: SANS,
          fontSize: 10,
          color: FADED,
          marginTop: 2,
        }}
      >
        {sub}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Group YTD GBP-sourced leads by month for the snapshot mini chart.
 * Returns one entry per month from Jan to now, even months with zero leads.
 */
function monthlyGbpLeadCounts(report: ComposedReport): { month: string; count: number }[] {
  const year = report.reportYear;
  const ytdLeads = report.leads.filter((l) => {
    if (!l.isGbpSourced) return false;
    const t = Date.parse(l.createdAt);
    if (!Number.isFinite(t)) return false;
    return new Date(t).getUTCFullYear() === year;
  });
  // Bucket by month index.
  const buckets = new Map<number, number>();
  for (const l of ytdLeads) {
    const m = new Date(l.createdAt).getUTCMonth();
    buckets.set(m, (buckets.get(m) ?? 0) + 1);
  }
  // Fill from Jan to current month.
  const currentMonth = new Date().getUTCMonth();
  const result: { month: string; count: number }[] = [];
  for (let m = 0; m <= currentMonth; m++) {
    result.push({
      month: `${year}-${String(m + 1).padStart(2, "0")}`,
      count: buckets.get(m) ?? 0,
    });
  }
  return result;
}
