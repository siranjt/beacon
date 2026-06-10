/**
 * Beam confidence calibration — Roadmap-v2-1.
 *
 * Manager + admin only. Beam emits `<confidence: NN%>` markers on most
 * assistant turns; the AskPanel bins them into high/medium/low and a
 * downstream POST persists the displayed tier on every thumbs vote
 * (see lib/ai/calibration.ts + the 2026-06-10 migration).
 *
 * This page surfaces per-tier hit rate (thumbs-up / total) across three
 * windows (7d / 30d / all-time) and a per-scope breakdown. A
 * well-calibrated Beam shows a monotonic line: low < medium < high.
 * Until enough votes accumulate the cells will read "—" — that's the
 * point. Calibration without measurement is asserted; this is the
 * measurement.
 *
 * Palette — ember (low), brass (medium), patina-as-high stand-in
 * because there's no shared --zoca-patina token. We use the same
 * watchfire hexes as ConfidenceBadge so the colors here match what
 * AMs actually see on the bubble.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail, isManagerOrAdmin } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import {
  getCalibrationStats,
  totalVotes,
  type CalibrationStats,
  type CalibrationTier,
  type TierStats,
} from "@/lib/ai/calibration";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Beam calibration · Admin · Beacon · Zoca",
};

// Watchfire palette — matches components/ai/ConfidenceBadge tierFor().
const HEX = {
  ember: "#C8431D",
  brass: "#D9A441",
  patina: "#4A7C59",
  lapis: "#2A4D5C",
  char: "#2B1F14",
} as const;

interface TierMeta {
  key: CalibrationTier;
  label: string;
  hint: string;
  color: string;
  bg: string;
}

const TIER_ORDER: TierMeta[] = [
  {
    key: "high",
    label: "High (≥80%)",
    hint: "Beam claimed it knew",
    color: HEX.patina,
    bg: "rgba(74, 124, 89, 0.10)",
  },
  {
    key: "medium",
    label: "Medium (55-79%)",
    hint: "Beam said it was likely",
    color: HEX.brass,
    bg: "rgba(217, 164, 65, 0.16)",
  },
  {
    key: "low",
    label: "Low (<55%)",
    hint: "Beam was guessing",
    color: HEX.ember,
    bg: "rgba(200, 67, 29, 0.08)",
  },
  {
    key: "null",
    label: "No marker",
    hint: "No confidence emitted (older turns)",
    color: "var(--zoca-text-3)",
    bg: "transparent",
  },
];

interface WindowDef {
  key: "7d" | "30d" | "all";
  label: string;
  windowDays: number | undefined;
}

const WINDOWS: WindowDef[] = [
  { key: "7d", label: "Last 7 days", windowDays: 7 },
  { key: "30d", label: "Last 30 days", windowDays: 30 },
  { key: "all", label: "All time", windowDays: undefined },
];

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtScope(scopeKey: string): string {
  if (scopeKey === "(unknown)") return "(unknown scope)";
  // customer-360:<entityId> → "customer-360 (per customer)" so we don't
  // explode the table with one row per customer scope_key. The per-row
  // detail isn't useful here; the kind is what tells us where Beam runs.
  const colonIdx = scopeKey.indexOf(":");
  if (colonIdx > 0) {
    const kind = scopeKey.slice(0, colonIdx);
    return `${kind} (per record)`;
  }
  return scopeKey;
}

/**
 * Roll up multi-record scope keys (customer-360:<entityId>,
 * performance-report:<entityId>, post-payment-customer:<cbId>) into a
 * single bucket per kind. Otherwise we'd surface thousands of rows.
 */
function rollupScopes(
  stats: CalibrationStats,
): Array<{ scope_label: string; stats: TierStats; total: number }> {
  const buckets = new Map<string, TierStats>();
  for (const row of stats.by_scope) {
    const label = fmtScope(row.scope_key);
    let agg = buckets.get(label);
    if (!agg) {
      agg = {
        high: { up: 0, down: 0, rate: null },
        medium: { up: 0, down: 0, rate: null },
        low: { up: 0, down: 0, rate: null },
        null: { up: 0, down: 0, rate: null },
      };
      buckets.set(label, agg);
    }
    for (const tier of TIER_ORDER) {
      agg[tier.key].up += row.stats[tier.key].up;
      agg[tier.key].down += row.stats[tier.key].down;
    }
  }
  const rows: Array<{ scope_label: string; stats: TierStats; total: number }> =
    [];
  buckets.forEach((agg, scope_label) => {
    for (const tier of TIER_ORDER) {
      const total = agg[tier.key].up + agg[tier.key].down;
      agg[tier.key].rate = total > 0 ? agg[tier.key].up / total : null;
    }
    rows.push({ scope_label, stats: agg, total: totalVotes(agg) });
  });
  rows.sort((a, b) => b.total - a.total);
  return rows;
}

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/admin/beacon-ai-calibration");
  }
  const role = getRoleForEmail(session.user.email);
  if (!isManagerOrAdmin(role)) {
    redirect("/");
  }

  const [stats7d, stats30d, statsAll] = await Promise.all([
    getCalibrationStats({ windowDays: 7 }),
    getCalibrationStats({ windowDays: 30 }),
    getCalibrationStats({}),
  ]);

  const windowData: { def: WindowDef; stats: CalibrationStats }[] = [
    { def: WINDOWS[0], stats: stats7d },
    { def: WINDOWS[1], stats: stats30d },
    { def: WINDOWS[2], stats: statsAll },
  ];

  const allTimeScopes = rollupScopes(statsAll);

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Beam calibration" homeHref="/" />
      <PageViewLogger
        agent="umbrella"
        surface="auth"
        metadata={{ kind: "admin_beacon_ai_calibration" }}
      />

      <div
        style={{
          padding: "1.5rem 2rem",
          fontFamily: "Georgia, 'Times New Roman', serif",
          color: "var(--zoca-text)",
          maxWidth: 1200,
          margin: "0 auto",
        }}
      >
        <div style={{ marginBottom: "1.5rem" }}>
          <h1
            style={{
              fontSize: "1.75rem",
              fontWeight: 700,
              margin: 0,
              marginBottom: "0.4rem",
            }}
          >
            Beam confidence calibration
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "0.95rem",
              color: "var(--zoca-text-2)",
              maxWidth: 720,
              lineHeight: 1.5,
            }}
          >
            Beam reports a confidence tier (
            <span style={{ color: HEX.patina, fontWeight: 600 }}>High</span>,{" "}
            <span style={{ color: HEX.brass, fontWeight: 600 }}>Medium</span>,{" "}
            <span style={{ color: HEX.ember, fontWeight: 600 }}>Low</span>) on
            most answers. A well-calibrated copilot shows a{" "}
            <em>monotonic hit rate</em>: thumbs-up share climbs from Low →
            Medium → High. If High lands near 50%, Beam is claiming
            certainty it hasn&rsquo;t earned. If Low lands near High, the
            tiers carry no information.
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "1rem",
            marginBottom: "2rem",
          }}
        >
          {windowData.map(({ def, stats }) => (
            <WindowCard key={def.key} label={def.label} stats={stats.overall} />
          ))}
        </div>

        <h2
          style={{
            fontSize: "1.2rem",
            fontWeight: 700,
            margin: "0 0 0.5rem 0",
          }}
        >
          All-time calibration curve
        </h2>
        <p
          style={{
            margin: "0 0 1rem 0",
            fontSize: "0.85rem",
            color: "var(--zoca-text-3)",
            maxWidth: 720,
            lineHeight: 1.5,
          }}
        >
          x-axis = the tier Beam reported. y-axis = the share of votes that
          came back thumbs-up. A monotonic line trending up-and-right is
          earned calibration.
        </p>
        <CalibrationCurve stats={statsAll.overall} />

        <h2
          style={{
            fontSize: "1.2rem",
            fontWeight: 700,
            margin: "2rem 0 0.75rem 0",
          }}
        >
          By scope (all time)
        </h2>
        <p
          style={{
            margin: "0 0 1rem 0",
            fontSize: "0.85rem",
            color: "var(--zoca-text-3)",
          }}
        >
          Per-surface hit rate by tier. Customer / report / post-payment
          scopes are rolled up to the kind so the table doesn&rsquo;t fan
          out per entity.
        </p>
        <PerScopeTable rows={allTimeScopes} />
      </div>
    </BeaconPageShell>
  );
}

interface WindowCardProps {
  label: string;
  stats: TierStats;
}

function WindowCard({ label, stats }: WindowCardProps) {
  const total = totalVotes(stats);
  return (
    <div
      style={{
        padding: "1.25rem",
        borderRadius: 10,
        background: "var(--zoca-bg-soft)",
        border: "1px solid var(--zoca-border)",
        boxShadow: "0 1px 3px rgba(43, 31, 20, 0.05)",
      }}
    >
      <div
        style={{
          fontSize: "0.8rem",
          letterSpacing: "1.5px",
          textTransform: "uppercase",
          color: "var(--zoca-text-3)",
          marginBottom: "0.5rem",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "1.75rem",
          fontWeight: 700,
          lineHeight: 1.1,
          color: "var(--zoca-text)",
          marginBottom: "0.6rem",
        }}
      >
        {total} {total === 1 ? "vote" : "votes"}
      </div>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.85rem",
        }}
      >
        <thead>
          <tr style={{ color: "var(--zoca-text-3)" }}>
            <th style={miniTh}>Tier</th>
            <th style={miniThNum}>Up</th>
            <th style={miniThNum}>Down</th>
            <th style={miniThNum}>Hit rate</th>
          </tr>
        </thead>
        <tbody>
          {TIER_ORDER.map((t) => {
            const slot = stats[t.key];
            const triaged = slot.up + slot.down;
            return (
              <tr key={t.key} style={{ borderTop: "1px dotted var(--zoca-border)" }}>
                <td
                  style={{
                    ...miniTd,
                    color: t.color,
                    fontWeight: 600,
                  }}
                >
                  {t.label}
                </td>
                <td style={miniTdNum}>{slot.up}</td>
                <td style={miniTdNum}>{slot.down}</td>
                <td
                  style={{
                    ...miniTdNum,
                    fontWeight: 700,
                    color: triaged > 0 ? t.color : "var(--zoca-text-3)",
                  }}
                >
                  {fmtPct(slot.rate)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Inline SVG calibration curve — tier on x, hit rate on y. Tiers with
 * zero votes render as hollow circles so the missing data is visible.
 */
function CalibrationCurve({ stats }: { stats: TierStats }) {
  const W = 560;
  const H = 220;
  const PAD_L = 48;
  const PAD_R = 24;
  const PAD_T = 16;
  const PAD_B = 36;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  // Three real tiers — exclude "null". Order low → medium → high so the
  // curve reads bottom-left to top-right when calibrated.
  const points = (["low", "medium", "high"] as const).map((k, i) => {
    const slot = stats[k];
    const triaged = slot.up + slot.down;
    const rate = triaged > 0 ? (slot.rate ?? 0) : null;
    const x = PAD_L + (innerW * i) / 2;
    const y = rate === null ? null : PAD_T + innerH * (1 - rate);
    return { k, i, x, y, rate, triaged };
  });

  // Connect only consecutive populated tiers — skip gaps cleanly.
  const segments: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.y === null || b.y === null) continue;
    segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }

  const yGridPercents = [0, 25, 50, 75, 100];
  const tierColors: Record<string, string> = {
    low: HEX.ember,
    medium: HEX.brass,
    high: HEX.patina,
  };
  const tierLabels: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
  };

  return (
    <div
      style={{
        background: "var(--zoca-bg-soft)",
        border: "1px solid var(--zoca-border)",
        borderRadius: 10,
        padding: "1rem",
      }}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label="Beam confidence calibration curve"
        style={{ display: "block" }}
      >
        {/* y-axis gridlines + labels */}
        {yGridPercents.map((p) => {
          const y = PAD_T + innerH * (1 - p / 100);
          return (
            <g key={p}>
              <line
                x1={PAD_L}
                y1={y}
                x2={W - PAD_R}
                y2={y}
                stroke="var(--zoca-border)"
                strokeDasharray={p === 0 || p === 100 ? "0" : "2 4"}
              />
              <text
                x={PAD_L - 8}
                y={y + 4}
                textAnchor="end"
                fontSize={10}
                fill="var(--zoca-text-3)"
                fontFamily="ui-monospace, monospace"
              >
                {p}%
              </text>
            </g>
          );
        })}
        {/* Connecting segments — ember on left, climbing toward patina */}
        {segments.map((s, i) => (
          <line
            key={`seg-${i}`}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke={HEX.char}
            strokeWidth={2}
            strokeLinecap="round"
          />
        ))}
        {/* Points */}
        {points.map((p) => {
          if (p.y === null) {
            return (
              <g key={p.k}>
                <circle
                  cx={p.x}
                  cy={PAD_T + innerH}
                  r={5}
                  fill="none"
                  stroke="var(--zoca-text-3)"
                  strokeDasharray="2 2"
                />
                <text
                  x={p.x}
                  y={PAD_T + innerH + 22}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--zoca-text-3)"
                  fontFamily="Georgia, serif"
                >
                  {tierLabels[p.k]}
                </text>
                <text
                  x={p.x}
                  y={PAD_T + innerH - 12}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--zoca-text-3)"
                  fontFamily="ui-monospace, monospace"
                >
                  no votes
                </text>
              </g>
            );
          }
          return (
            <g key={p.k}>
              <circle
                cx={p.x}
                cy={p.y}
                r={6}
                fill={tierColors[p.k]}
                stroke={HEX.char}
                strokeWidth={1.5}
              />
              <text
                x={p.x}
                y={PAD_T + innerH + 22}
                textAnchor="middle"
                fontSize={11}
                fill={tierColors[p.k]}
                fontFamily="Georgia, serif"
                fontWeight={600}
              >
                {tierLabels[p.k]}
              </text>
              <text
                x={p.x}
                y={p.y - 12}
                textAnchor="middle"
                fontSize={11}
                fill={HEX.char}
                fontFamily="ui-monospace, monospace"
                fontWeight={600}
              >
                {fmtPct(p.rate)}
              </text>
              <text
                x={p.x}
                y={p.y + 22}
                textAnchor="middle"
                fontSize={9}
                fill="var(--zoca-text-3)"
                fontFamily="ui-monospace, monospace"
              >
                n={p.triaged}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function PerScopeTable({
  rows,
}: {
  rows: Array<{ scope_label: string; stats: TierStats; total: number }>;
}) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: "1.25rem",
          borderRadius: 10,
          background: "var(--zoca-bg-soft)",
          border: "1px solid var(--zoca-border)",
          color: "var(--zoca-text-2)",
          fontSize: "0.9rem",
        }}
      >
        No Beam feedback recorded yet.
      </div>
    );
  }

  return (
    <div
      style={{
        borderRadius: 10,
        overflow: "hidden",
        border: "1px solid var(--zoca-border)",
        background: "var(--zoca-bg-soft)",
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.9rem",
        }}
      >
        <thead>
          <tr
            style={{
              background: "var(--zoca-bg-tint)",
              color: "var(--zoca-text)",
              textAlign: "left",
            }}
          >
            <th style={thStyle}>Scope</th>
            {TIER_ORDER.map((t) => (
              <th
                key={t.key}
                style={{ ...thNumStyle, color: t.color }}
              >
                {t.label}
              </th>
            ))}
            <th style={thNumStyle}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.scope_label}
              style={{ borderTop: "1px solid var(--zoca-border)" }}
            >
              <td style={tdStyle}>{r.scope_label}</td>
              {TIER_ORDER.map((t) => {
                const slot = r.stats[t.key];
                const triaged = slot.up + slot.down;
                return (
                  <td
                    key={t.key}
                    style={{
                      ...tdNumStyle,
                      fontWeight: 700,
                      color: triaged > 0 ? t.color : "var(--zoca-text-3)",
                    }}
                    title={`${slot.up} up / ${slot.down} down`}
                  >
                    {fmtPct(slot.rate)}
                  </td>
                );
              })}
              <td style={{ ...tdNumStyle, color: "var(--zoca-text-3)" }}>
                {r.total}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "0.65rem 0.9rem",
  fontSize: "0.75rem",
  fontWeight: 700,
  letterSpacing: "1px",
  textTransform: "uppercase",
};

const thNumStyle: React.CSSProperties = {
  ...thStyle,
  textAlign: "right",
};

const tdStyle: React.CSSProperties = {
  padding: "0.6rem 0.9rem",
  color: "var(--zoca-text)",
};

const tdNumStyle: React.CSSProperties = {
  ...tdStyle,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const miniTh: React.CSSProperties = {
  textAlign: "left",
  fontSize: "0.7rem",
  fontWeight: 600,
  letterSpacing: "0.5px",
  textTransform: "uppercase",
  padding: "0.3rem 0",
};

const miniThNum: React.CSSProperties = {
  ...miniTh,
  textAlign: "right",
};

const miniTd: React.CSSProperties = {
  padding: "0.4rem 0",
  fontSize: "0.8rem",
};

const miniTdNum: React.CSSProperties = {
  ...miniTd,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};
