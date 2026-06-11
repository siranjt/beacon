/**
 * META-A5 — Anthropic spend observability page.
 *
 * Admin-only. Single-page dashboard that surfaces:
 *   • Month-to-date total
 *   • Projected end-of-month (linear projection from current daily rate)
 *   • Today's running spend
 *   • Alert banner when projected > $100 OR actual > $90 (the user's cap
 *     is $100-120; we want a few days of runway to react)
 *   • Per-day bar chart for the last 30 days
 *   • Per-feature breakdown table (where the burn is happening)
 *   • Per-model breakdown table (Sonnet vs Haiku vs Opus)
 *
 * Numbers come from our own `beacon_anthropic_spend_log` table, populated
 * by `lib/ai/spend-log.ts` at every Anthropic call site. Fresh within
 * seconds of each call landing. Phase 2 will add a cross-check against
 * Anthropic's official usage-report endpoint.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import {
  buildSpendOverview,
  type SpendOverview,
  type SpendDaily,
  type SpendByFeature,
  type SpendByModel,
} from "@/lib/ai/spend-overview";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Anthropic spend · Admin · Beacon · Zoca",
};

// Watchfire palette — same hexes as the calibration page so the admin
// surfaces feel consistent.
const HEX = {
  ember: "#C8431D",
  brass: "#D9A441",
  patina: "#4A7C59",
  lapis: "#2A4D5C",
  char: "#2B1F14",
} as const;

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/admin/anthropic-spend");
  }
  const role = getRoleForEmail(session.user.email);
  if (role !== "admin") {
    redirect("/");
  }

  const overview = await buildSpendOverview();

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Anthropic spend" homeHref="/" />
      <PageViewLogger
        agent="umbrella"
        surface="auth"
        metadata={{ kind: "admin_anthropic_spend" }}
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
            Anthropic spend
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
            Live month-to-date and projected end-of-month spend on the
            Anthropic API, instrumented from every call site in the app. Cap
            target is <strong>$100&ndash;$120/mo</strong>; this page flags
            before you breach it. Numbers update within seconds of each API
            call landing.
          </p>
        </div>

        {overview.alert_state !== "ok" && overview.alert_reason && (
          <AlertBanner state={overview.alert_state} reason={overview.alert_reason} />
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "1rem",
            marginBottom: "2rem",
          }}
        >
          <KpiCard
            label="Month to date"
            value={fmtUsd(overview.mtd_usd)}
            sub={`${overview.days_elapsed} of ${overview.days_in_month} days elapsed`}
            color={
              overview.alert_state === "critical"
                ? HEX.ember
                : "var(--zoca-text)"
            }
          />
          <KpiCard
            label="Projected end-of-month"
            value={fmtUsd(overview.projected_eom_usd)}
            sub={`At current daily rate of ${fmtUsd(
              overview.days_elapsed > 0
                ? overview.mtd_usd / overview.days_elapsed
                : 0,
            )}/day`}
            color={
              overview.projected_eom_usd > 100
                ? HEX.ember
                : overview.projected_eom_usd > 80
                  ? HEX.brass
                  : HEX.patina
            }
          />
          <KpiCard
            label="Today"
            value={fmtUsd(overview.today_usd)}
            sub={
              overview.today_usd >= 5
                ? "Slack alert fires at $5/day"
                : "Quiet so far"
            }
            color={overview.today_usd >= 5 ? HEX.brass : "var(--zoca-text)"}
          />
        </div>

        <SectionHeader
          title="Daily spend — last 30 days"
          hint="Each bar is one calendar day (UTC). Tallest = highest spend day."
        />
        <DailyBarChart rows={overview.daily} />

        <SectionHeader
          title="Per feature — this month"
          hint="Which surfaces are burning the most. `ask` and `evaluator` are typically the heavyweights."
        />
        <PerFeatureTable rows={overview.per_feature} total={overview.mtd_usd} />

        <SectionHeader
          title="Per model — this month"
          hint="Sonnet is the interactive copilot; Haiku is most crons; Opus is rare overrides."
        />
        <PerModelTable rows={overview.per_model} total={overview.mtd_usd} />

        <p
          style={{
            margin: "2rem 0 0",
            fontSize: "0.8rem",
            color: "var(--zoca-text-3)",
            lineHeight: 1.5,
            fontStyle: "italic",
          }}
        >
          Source: <code>beacon_anthropic_spend_log</code>, populated by
          <code> lib/ai/spend-log.ts</code> at every Anthropic call site
          (ask, suggest, evaluator, fact extraction, comms perspective,
          shadow verdict, NK classify, briefings, drafts). Phase 2 will
          cross-check against Anthropic&rsquo;s usage-report API.
        </p>
      </div>
    </BeaconPageShell>
  );
}

function AlertBanner({
  state,
  reason,
}: {
  state: "warn" | "critical";
  reason: string;
}) {
  const isCritical = state === "critical";
  return (
    <div
      role="alert"
      style={{
        padding: "1rem 1.25rem",
        marginBottom: "1.5rem",
        borderRadius: 8,
        background: isCritical
          ? "rgba(200, 67, 29, 0.12)"
          : "rgba(217, 164, 65, 0.16)",
        border: `1px solid ${isCritical ? HEX.ember : HEX.brass}`,
        color: isCritical ? HEX.ember : HEX.char,
        fontSize: "0.95rem",
        lineHeight: 1.5,
      }}
    >
      <strong style={{ display: "block", marginBottom: 4 }}>
        {isCritical
          ? "Critical — spend cap at risk"
          : "Heads up — projection over $100"}
      </strong>
      {reason}
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
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
          fontSize: "0.75rem",
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
          fontSize: "2.25rem",
          fontWeight: 700,
          lineHeight: 1.1,
          color,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: "0.8rem",
          color: "var(--zoca-text-2)",
          marginTop: "0.5rem",
        }}
      >
        {sub}
      </div>
    </div>
  );
}

function SectionHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <>
      <h2
        style={{
          fontSize: "1.2rem",
          fontWeight: 700,
          margin: "2rem 0 0.5rem 0",
        }}
      >
        {title}
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
        {hint}
      </p>
    </>
  );
}

/**
 * Inline CSS bar chart — no chart library dependency. Each bar's height
 * scales to the max-spend day in the window. The latest day is on the
 * right so the eye reads the trend left-to-right naturally.
 *
 * Always renders the last 30 day slots even on days with zero spend, so
 * the gaps in the chart are visible (instead of compressing 12 active
 * days to a dense block that hides patterns).
 */
function DailyBarChart({ rows }: { rows: SpendDaily[] }) {
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
        No Anthropic spend recorded yet. Either the day window is empty or
        the instrumentation hasn&rsquo;t shipped yet — check{" "}
        <code>lib/ai/spend-log.ts</code> for call-site coverage.
      </div>
    );
  }

  // Build a 30-slot list, indexed by YYYY-MM-DD, so missing days render
  // as empty bars instead of being skipped.
  const today = new Date();
  const byDay = new Map<string, SpendDaily>();
  for (const r of rows) byDay.set(r.day, r);

  const slots: SpendDaily[] = [];
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    slots.push(byDay.get(key) ?? { day: key, cost_usd: 0, call_count: 0 });
  }

  const maxSpend = Math.max(1e-6, ...slots.map((s) => s.cost_usd));
  // Heuristic ember threshold: $5/day is our daily-alert trigger.
  const isHighDay = (s: SpendDaily) => s.cost_usd >= 5;

  return (
    <div
      style={{
        padding: "1.25rem",
        borderRadius: 10,
        background: "var(--zoca-bg-soft)",
        border: "1px solid var(--zoca-border)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${slots.length}, 1fr)`,
          gap: 3,
          alignItems: "end",
          height: 180,
        }}
      >
        {slots.map((s) => {
          const heightPct = (s.cost_usd / maxSpend) * 100;
          const ember = isHighDay(s);
          return (
            <div
              key={s.day}
              title={`${s.day} — ${fmtUsd(s.cost_usd)} across ${s.call_count} calls`}
              style={{
                height: `${Math.max(1, heightPct)}%`,
                background: ember ? HEX.ember : HEX.lapis,
                opacity: s.cost_usd === 0 ? 0.18 : 1,
                borderRadius: "2px 2px 0 0",
                minHeight: 2,
              }}
            />
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: "0.6rem",
          fontSize: "0.7rem",
          color: "var(--zoca-text-3)",
          fontFamily: "ui-monospace, monospace",
        }}
      >
        <span>{slots[0].day}</span>
        <span style={{ color: HEX.ember }}>
          Peak: {fmtUsd(maxSpend)}
        </span>
        <span>{slots[slots.length - 1].day}</span>
      </div>
    </div>
  );
}

function PerFeatureTable({
  rows,
  total,
}: {
  rows: SpendByFeature[];
  total: number;
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
        No spend recorded this month yet.
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
            <th style={thStyle}>Feature</th>
            <th style={thNumStyle}>Calls</th>
            <th style={thNumStyle}>Spend</th>
            <th style={thNumStyle}>% of MTD</th>
            <th style={thStyle}>Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = total > 0 ? (r.cost_usd / total) * 100 : 0;
            return (
              <tr
                key={r.feature}
                style={{ borderTop: "1px solid var(--zoca-border)" }}
              >
                <td style={tdStyle}>
                  <code>{r.feature}</code>
                </td>
                <td style={tdNumStyle}>{r.call_count.toLocaleString()}</td>
                <td style={{ ...tdNumStyle, fontWeight: 600 }}>
                  {fmtUsd(r.cost_usd)}
                </td>
                <td style={tdNumStyle}>{pct.toFixed(1)}%</td>
                <td style={{ ...tdStyle, width: "30%" }}>
                  <div
                    style={{
                      height: 6,
                      borderRadius: 3,
                      background: "var(--zoca-border)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        background:
                          pct > 50
                            ? HEX.ember
                            : pct > 25
                              ? HEX.brass
                              : HEX.lapis,
                      }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PerModelTable({
  rows,
  total,
}: {
  rows: SpendByModel[];
  total: number;
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
        No model spend recorded this month yet.
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
            <th style={thStyle}>Model</th>
            <th style={thNumStyle}>Calls</th>
            <th style={thNumStyle}>Spend</th>
            <th style={thNumStyle}>% of MTD</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = total > 0 ? (r.cost_usd / total) * 100 : 0;
            return (
              <tr
                key={r.model}
                style={{ borderTop: "1px solid var(--zoca-border)" }}
              >
                <td style={tdStyle}>
                  <code>{r.model}</code>
                </td>
                <td style={tdNumStyle}>{r.call_count.toLocaleString()}</td>
                <td style={{ ...tdNumStyle, fontWeight: 600 }}>
                  {fmtUsd(r.cost_usd)}
                </td>
                <td style={tdNumStyle}>{pct.toFixed(1)}%</td>
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
