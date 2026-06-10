/**
 * Keeper reject-rate dashboard — Wave 1.5 quality check.
 *
 * Manager + admin only. Surfaces the share of Haiku-extracted candidate
 * facts (source_type='beacon_ai_extracted') that AMs reject during
 * triage on the Validate inbox.
 *
 * Three windows — 7-day, 30-day, all-time — each computed from the
 * version log: a candidate's outcome is the latest change_reason on its
 * `beacon_brain_fact_versions` rows. Pending (untriaged) candidates are
 * surfaced separately so the user can read freshness alongside reject
 * rate.
 *
 * Rule of thumb: a window with reject_rate > 0.30 means the Haiku
 * extraction prompt is too aggressive — surface a copper callout banner
 * so the team knows to tighten it. Per-AM rollup below for spotting
 * triager-specific patterns (an outlier AM with a much higher reject
 * rate is also a signal — same fact stream, different verdict).
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail, isManagerOrAdmin } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import {
  getCandidateOutcomeStats,
  getCandidateOutcomeStatsByAm,
  type CandidateOutcomeStats,
  type CandidateOutcomeStatsByAm,
} from "@/lib/brain/repo";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Keeper reject rate · Admin · Beacon · Zoca",
};

/** Threshold above which we surface the "tighten the prompt" callout. */
const REJECT_RATE_ALERT_THRESHOLD = 0.30;

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

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtAmEmail(email: string): string {
  if (email === "__none__") return "(no AM assigned)";
  return email;
}

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/admin/brain/reject-rate");
  }
  const role = getRoleForEmail(session.user.email);
  if (!isManagerOrAdmin(role)) {
    redirect("/");
  }

  // Fan out the three window queries + the all-time per-AM rollup in
  // parallel. The per-AM rollup uses the all-time window because the
  // 7d / 30d cuts get noisy fast at the per-AM grain.
  const [stats7d, stats30d, statsAll, perAm] = await Promise.all([
    getCandidateOutcomeStats({ windowDays: 7 }),
    getCandidateOutcomeStats({ windowDays: 30 }),
    getCandidateOutcomeStats({}),
    getCandidateOutcomeStatsByAm({}),
  ]);

  const windowData: { def: WindowDef; stats: CandidateOutcomeStats }[] = [
    { def: WINDOWS[0], stats: stats7d },
    { def: WINDOWS[1], stats: stats30d },
    { def: WINDOWS[2], stats: statsAll },
  ];

  // Find the first window whose reject rate trips the threshold — used
  // for the callout copy. We surface only one banner so the page doesn't
  // wallpaper itself when all three windows are red.
  const tripped = windowData.find(
    (w) =>
      w.stats.confirmed + w.stats.edit_confirmed + w.stats.rejected > 0 &&
      w.stats.reject_rate > REJECT_RATE_ALERT_THRESHOLD,
  );

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Keeper reject rate" homeHref="/" />
      <PageViewLogger
        agent="umbrella"
        surface="auth"
        metadata={{ kind: "admin_brain_reject_rate" }}
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
            Reject rate
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
            Share of Haiku-extracted candidate facts that AMs reject during
            triage. Rule of thumb: <strong>over 30 %</strong> in any
            window means the extraction prompt is too aggressive and should
            be tightened. Pending candidates are excluded from the rate so
            the metric isn&rsquo;t diluted by an untriaged backlog.
          </p>
        </div>

        {tripped && (
          <div
            style={{
              padding: "1rem 1.25rem",
              marginBottom: "1.5rem",
              borderRadius: 8,
              background: "var(--zoca-pink-soft)",
              border: "1px solid var(--zoca-pink)",
              color: "var(--zoca-pink-bright)",
              fontSize: "0.95rem",
              lineHeight: 1.5,
            }}
            role="alert"
          >
            <strong style={{ display: "block", marginBottom: 4 }}>
              Reject rate exceeds {Math.round(REJECT_RATE_ALERT_THRESHOLD * 100)}%
              in the {tripped.def.label.toLowerCase()} window
            </strong>
            Consider tightening the Haiku extraction prompt
            (<code>lib/brain/extract-from-notes.ts</code>). Current rate:
            {" "}{fmtPct(tripped.stats.reject_rate)} on{" "}
            {tripped.stats.confirmed + tripped.stats.edit_confirmed + tripped.stats.rejected}{" "}
            triaged candidates.
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "1rem",
            marginBottom: "2rem",
          }}
        >
          {windowData.map(({ def, stats }) => {
            const triaged = stats.confirmed + stats.edit_confirmed + stats.rejected;
            const isAlert =
              triaged > 0 && stats.reject_rate > REJECT_RATE_ALERT_THRESHOLD;
            return (
              <WindowCard
                key={def.key}
                label={def.label}
                stats={stats}
                triaged={triaged}
                isAlert={isAlert}
              />
            );
          })}
        </div>

        <h2
          style={{
            fontSize: "1.2rem",
            fontWeight: 700,
            margin: "0 0 0.75rem 0",
          }}
        >
          By Account Manager (all time)
        </h2>
        <p
          style={{
            margin: "0 0 1rem 0",
            fontSize: "0.85rem",
            color: "var(--zoca-text-3)",
          }}
        >
          Per-AM rejection patterns. Outliers can indicate either a
          calibration gap with that triager or systematic Haiku misses
          on a particular customer book.
        </p>
        <PerAmTable rows={perAm} />
      </div>
    </BeaconPageShell>
  );
}

interface WindowCardProps {
  label: string;
  stats: CandidateOutcomeStats;
  triaged: number;
  isAlert: boolean;
}

function WindowCard({ label, stats, triaged, isAlert }: WindowCardProps) {
  return (
    <div
      style={{
        padding: "1.25rem",
        borderRadius: 10,
        background: "var(--zoca-bg-soft)",
        border: isAlert
          ? "2px solid var(--zoca-pink)"
          : "1px solid var(--zoca-border)",
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
          fontSize: "2.5rem",
          fontWeight: 700,
          lineHeight: 1.1,
          color: isAlert ? "var(--zoca-pink-bright)" : "var(--zoca-text)",
        }}
      >
        {triaged > 0 ? fmtPct(stats.reject_rate) : "—"}
      </div>
      <div
        style={{
          fontSize: "0.85rem",
          color: "var(--zoca-text-2)",
          marginTop: "0.4rem",
        }}
      >
        {triaged > 0
          ? `${stats.rejected} of ${triaged} triaged`
          : "No triaged candidates yet"}
      </div>
      <div
        style={{
          marginTop: "0.75rem",
          paddingTop: "0.75rem",
          borderTop: "1px dotted var(--zoca-border)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "0.4rem 0.75rem",
          fontSize: "0.8rem",
          color: "var(--zoca-text-2)",
        }}
      >
        <div>Confirmed</div>
        <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {stats.confirmed}
        </div>
        <div>Edit + confirmed</div>
        <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {stats.edit_confirmed}
        </div>
        <div>Rejected</div>
        <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {stats.rejected}
        </div>
        <div style={{ color: "var(--zoca-text-3)" }}>Pending</div>
        <div
          style={{
            textAlign: "right",
            color: "var(--zoca-text-3)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {stats.pending}
        </div>
        <div style={{ color: "var(--zoca-text-3)" }}>Total extracted</div>
        <div
          style={{
            textAlign: "right",
            color: "var(--zoca-text-3)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {stats.total}
        </div>
      </div>
    </div>
  );
}

function PerAmTable({ rows }: { rows: CandidateOutcomeStatsByAm[] }) {
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
        No Haiku-extracted candidates on record yet.
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
            <th style={thStyle}>Account Manager</th>
            <th style={thNumStyle}>Reject rate</th>
            <th style={thNumStyle}>Rejected</th>
            <th style={thNumStyle}>Confirmed</th>
            <th style={thNumStyle}>Edit + confirmed</th>
            <th style={thNumStyle}>Pending</th>
            <th style={thNumStyle}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const triaged = r.confirmed + r.edit_confirmed + r.rejected;
            const isAlert =
              triaged > 0 && r.reject_rate > REJECT_RATE_ALERT_THRESHOLD;
            return (
              <tr
                key={r.owning_am_email}
                style={{
                  borderTop: "1px solid var(--zoca-border)",
                  background: isAlert ? "var(--zoca-pink-soft)" : undefined,
                }}
              >
                <td style={tdStyle}>{fmtAmEmail(r.owning_am_email)}</td>
                <td
                  style={{
                    ...tdNumStyle,
                    fontWeight: 700,
                    color: isAlert ? "var(--zoca-pink-bright)" : undefined,
                  }}
                >
                  {triaged > 0 ? fmtPct(r.reject_rate) : "—"}
                </td>
                <td style={tdNumStyle}>{r.rejected}</td>
                <td style={tdNumStyle}>{r.confirmed}</td>
                <td style={tdNumStyle}>{r.edit_confirmed}</td>
                <td style={{ ...tdNumStyle, color: "var(--zoca-text-3)" }}>
                  {r.pending}
                </td>
                <td style={{ ...tdNumStyle, color: "var(--zoca-text-3)" }}>
                  {r.total}
                </td>
              </tr>
            );
          })}
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
