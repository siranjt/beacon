"use client";

/**
 * Shadow Verdict — admin client view.
 *
 * Top strip: today's agreement rate, drift histogram, 28-day trend,
 * stability metric, AM-feedback aggregates.
 * Main table: today's disagreements (filterable: disagree/all/llm-flagged/skip).
 * Row drawer: per-entity LLM verdict + reasoning + 28-day history.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ShadowVerdictRow, Tier } from "@/lib/customer/shadow-verdict/types";

type SummaryPayload = {
  run_date: string;
  drift_histogram: { agree: number; adjacent: number; skip: number };
  agreement_trend: Array<{
    run_date: string;
    total: number;
    agreed: number;
    agreement_pct: number;
  }>;
  stability: { total_entities: number; avg_stability_pct: number };
  feedback_aggregates: {
    total_votes: number;
    accurate_votes: number;
    accuracy_pct: number;
    by_tier: Record<Tier, { total: number; accurate: number; accuracy_pct: number }>;
  };
};

type VerdictsPayload = {
  run_date: string;
  filter: string;
  total: number;
  filtered: number;
  rows: ShadowVerdictRow[];
};

type EntityHistory = {
  entity_id: string;
  history: Array<{
    run_date: string;
    deterministic_tier: Tier;
    llm_tier: Tier;
    agreement: boolean;
    drift_severity: number;
  }>;
};

const TIER_TONE: Record<Tier, { fg: string; bg: string; label: string }> = {
  RED: { fg: "#7a1f1f", bg: "rgba(196, 73, 73, 0.18)", label: "RED" },
  YELLOW: { fg: "#6b5310", bg: "rgba(217, 168, 56, 0.22)", label: "YELLOW" },
  GREEN: { fg: "#1f4d2f", bg: "rgba(73, 153, 100, 0.20)", label: "GREEN" },
};

function TierPill({ tier }: { tier: Tier }) {
  const tone = TIER_TONE[tier];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: tone.bg,
        color: tone.fg,
        fontWeight: 700,
        fontSize: 11,
        letterSpacing: 0.4,
      }}
    >
      {tone.label}
    </span>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warn" | "good";
}) {
  const accent =
    tone === "warn" ? "#a85a1a" : tone === "good" ? "#1f4d2f" : "var(--ink, #2D4843)";
  return (
    <div
      style={{
        background: "rgba(252, 246, 232, 0.7)",
        border: "1px solid rgba(45, 72, 67, 0.14)",
        borderRadius: 12,
        padding: "14px 16px",
        minWidth: 170,
        flex: "1 1 170px",
      }}
    >
      <div style={{ fontSize: 11, letterSpacing: 0.8, textTransform: "uppercase", color: "#7a715f" }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontFamily: "Georgia, serif", color: accent, marginTop: 4 }}>
        {value}
      </div>
      {hint ? (
        <div style={{ fontSize: 12, color: "#7a715f", marginTop: 2 }}>{hint}</div>
      ) : null}
    </div>
  );
}

function TrendStrip({
  trend,
}: {
  trend: Array<{ run_date: string; agreement_pct: number; total: number }>;
}) {
  if (trend.length === 0) {
    return (
      <div style={{ color: "#7a715f", fontSize: 13 }}>
        No agreement data yet — the shadow cron lands its first row at 23:30 UTC.
      </div>
    );
  }
  const max = 100;
  const W = 540;
  const H = 60;
  const points = trend
    .map((d, i) => {
      const x = trend.length === 1 ? W / 2 : (i / (trend.length - 1)) * W;
      const y = H - (d.agreement_pct / max) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <div>
      <div style={{ fontSize: 11, letterSpacing: 0.8, textTransform: "uppercase", color: "#7a715f", marginBottom: 6 }}>
        Agreement · last {trend.length} days
      </div>
      <svg width={W} height={H} style={{ overflow: "visible" }}>
        <polyline
          fill="none"
          stroke="#a85a1a"
          strokeWidth={1.5}
          points={points}
        />
        {trend.map((d, i) => {
          const x = trend.length === 1 ? W / 2 : (i / (trend.length - 1)) * W;
          const y = H - (d.agreement_pct / max) * H;
          return (
            <circle
              key={d.run_date}
              cx={x}
              cy={y}
              r={2.2}
              fill="#a85a1a"
            >
              <title>
                {d.run_date}: {d.agreement_pct}% ({d.total} customers)
              </title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}

function pct(n: number, d: number): string {
  if (!d) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

export default function ShadowVerdictView() {
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const [date, setDate] = useState(today);
  const [filter, setFilter] = useState<"disagree" | "all" | "llm-flagged" | "skip">("disagree");
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [verdicts, setVerdicts] = useState<VerdictsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ShadowVerdictRow | null>(null);
  const [history, setHistory] = useState<EntityHistory | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sRes, vRes] = await Promise.all([
        fetch(`/api/admin/shadow-verdict/summary?date=${date}`, { cache: "no-store" }),
        fetch(
          `/api/admin/shadow-verdict/verdicts?date=${date}&filter=${filter}`,
          { cache: "no-store" },
        ),
      ]);
      if (!sRes.ok) throw new Error(`summary ${sRes.status}`);
      if (!vRes.ok) throw new Error(`verdicts ${vRes.status}`);
      setSummary((await sRes.json()) as SummaryPayload);
      setVerdicts((await vRes.json()) as VerdictsPayload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [date, filter]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const onRowClick = useCallback(async (row: ShadowVerdictRow) => {
    setSelected(row);
    setHistory(null);
    try {
      const res = await fetch(`/api/admin/shadow-verdict/entity/${row.entity_id}`, {
        cache: "no-store",
      });
      if (res.ok) setHistory((await res.json()) as EntityHistory);
    } catch {
      // soft fail — drawer still shows what we have on the row
    }
  }, []);

  const drift = summary?.drift_histogram ?? { agree: 0, adjacent: 0, skip: 0 };
  const total = drift.agree + drift.adjacent + drift.skip;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, paddingBottom: 80 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div>
          <h1 style={{ fontFamily: "Georgia, serif", margin: 0, fontSize: 28, color: "var(--ink, #2D4843)" }}>
            Shadow verdict
          </h1>
          <p style={{ marginTop: 4, color: "#7a715f", fontSize: 13, maxWidth: 720 }}>
            Daily LLM second-opinion runs alongside Customer Beacon&apos;s deterministic scoring. The
            engine&apos;s tier is what AMs see today; the LLM&apos;s verdict is recorded silently for the
            4-week shadow window. Use this page to watch agreement rate, drift, and confidence drift over
            time, then decide whether to augment, replace, or drop.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <label style={{ fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", color: "#7a715f" }}>
            Date
          </label>
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            style={{
              padding: "6px 8px",
              borderRadius: 8,
              border: "1px solid rgba(45,72,67,0.2)",
              background: "rgba(252,246,232,0.7)",
            }}
          />
        </div>
      </header>

      {error ? (
        <div style={{ background: "rgba(196,73,73,0.12)", color: "#7a1f1f", padding: 12, borderRadius: 8 }}>
          {error}
        </div>
      ) : null}

      <section style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <StatCard
          label="Customers shadow-run"
          value={String(total)}
          hint={total === 0 ? "Cron hasn't landed yet today" : `as of ${summary?.run_date ?? date}`}
        />
        <StatCard
          label="Agreement"
          value={pct(drift.agree, total)}
          hint={`${drift.agree} agree / ${total} total`}
          tone={total > 0 && drift.agree / total > 0.7 ? "good" : "default"}
        />
        <StatCard
          label="Adjacent disagree"
          value={String(drift.adjacent)}
          hint="LLM off by one tier"
          tone={drift.adjacent > 0 ? "warn" : "default"}
        />
        <StatCard
          label="Skip disagree"
          value={String(drift.skip)}
          hint="LLM skipped a tier (RED↔GREEN)"
          tone={drift.skip > 0 ? "warn" : "default"}
        />
        <StatCard
          label="Stability (14d)"
          value={
            summary?.stability?.avg_stability_pct != null
              ? `${summary.stability.avg_stability_pct}%`
              : "—"
          }
          hint="LLM verdict consistency day-to-day"
        />
        <StatCard
          label="AM feedback (28d)"
          value={
            summary?.feedback_aggregates?.total_votes
              ? `${summary.feedback_aggregates.accuracy_pct}%`
              : "—"
          }
          hint={`${summary?.feedback_aggregates?.total_votes ?? 0} votes`}
        />
      </section>

      <section
        style={{
          background: "rgba(252, 246, 232, 0.85)",
          border: "1px solid rgba(45, 72, 67, 0.14)",
          borderRadius: 12,
          padding: "14px 18px",
        }}
      >
        <TrendStrip trend={summary?.agreement_trend ?? []} />
      </section>

      <section style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {(["disagree", "skip", "llm-flagged", "all"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              border:
                filter === f
                  ? "1px solid #a85a1a"
                  : "1px solid rgba(45, 72, 67, 0.18)",
              background:
                filter === f ? "rgba(168, 90, 26, 0.12)" : "transparent",
              color: filter === f ? "#7a3a0d" : "var(--ink, #2D4843)",
              fontSize: 12,
              cursor: "pointer",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {f === "disagree"
              ? "Disagreements"
              : f === "skip"
                ? "Tier skips"
                : f === "llm-flagged"
                  ? "LLM-flagged"
                  : "All"}
          </button>
        ))}
        <div style={{ marginLeft: "auto", color: "#7a715f", fontSize: 12 }}>
          {verdicts ? `${verdicts.filtered} of ${verdicts.total}` : null}
        </div>
      </section>

      <section
        style={{
          background: "rgba(252, 246, 232, 0.85)",
          border: "1px solid rgba(45, 72, 67, 0.14)",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        {loading ? (
          <div style={{ padding: 24, color: "#7a715f" }}>Loading…</div>
        ) : !verdicts || verdicts.rows.length === 0 ? (
          <div style={{ padding: 24, color: "#7a715f" }}>
            {total === 0
              ? "No shadow rows yet for this date — the cron lands at 23:30 UTC daily."
              : "No rows match the current filter."}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr
                style={{
                  background: "rgba(45,72,67,0.05)",
                  textAlign: "left",
                  fontSize: 11,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  color: "#7a715f",
                }}
              >
                <th style={{ padding: "10px 14px" }}>Customer</th>
                <th style={{ padding: "10px 14px" }}>AM</th>
                <th style={{ padding: "10px 14px" }}>Engine</th>
                <th style={{ padding: "10px 14px" }}>LLM</th>
                <th style={{ padding: "10px 14px" }}>Conf.</th>
                <th style={{ padding: "10px 14px" }}>Driver</th>
                <th style={{ padding: "10px 14px" }}>Reasoning</th>
              </tr>
            </thead>
            <tbody>
              {verdicts.rows.map((r) => (
                <tr
                  key={`${r.run_date}-${r.entity_id}`}
                  onClick={() => onRowClick(r)}
                  style={{
                    cursor: "pointer",
                    borderTop: "1px solid rgba(45,72,67,0.08)",
                    background:
                      selected?.entity_id === r.entity_id ? "rgba(168,90,26,0.06)" : "transparent",
                    transition: "background 120ms ease",
                  }}
                >
                  <td style={{ padding: "10px 14px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.bizname ?? r.entity_id.slice(0, 8)}
                  </td>
                  <td style={{ padding: "10px 14px", color: "#7a715f" }}>{r.am_name ?? "—"}</td>
                  <td style={{ padding: "10px 14px" }}>
                    <TierPill tier={r.deterministic_tier} />
                  </td>
                  <td style={{ padding: "10px 14px" }}>
                    <TierPill tier={r.llm_tier} />
                  </td>
                  <td style={{ padding: "10px 14px", fontVariantNumeric: "tabular-nums" }}>
                    {r.llm_confidence}
                  </td>
                  <td style={{ padding: "10px 14px", color: "#7a715f" }}>{r.llm_primary_driver}</td>
                  <td
                    style={{
                      padding: "10px 14px",
                      color: "#7a715f",
                      maxWidth: 360,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.llm_reasoning}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected ? (
        <EntityDrawer
          row={selected}
          history={history}
          onClose={() => {
            setSelected(null);
            setHistory(null);
          }}
        />
      ) : null}
    </div>
  );
}

function EntityDrawer({
  row,
  history,
  onClose,
}: {
  row: ShadowVerdictRow;
  history: EntityHistory | null;
  onClose: () => void;
}) {
  const signals = useMemo(
    () => (Array.isArray(row.llm_key_signals) ? row.llm_key_signals : []),
    [row.llm_key_signals],
  );
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20, 25, 24, 0.4)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(540px, 100%)",
          height: "100%",
          background: "var(--parchment, #fcf6e8)",
          borderLeft: "1px solid rgba(45, 72, 67, 0.18)",
          overflowY: "auto",
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ margin: 0, fontFamily: "Georgia, serif", fontSize: 22, color: "var(--ink, #2D4843)" }}>
              {row.bizname ?? row.entity_id.slice(0, 8)}
            </h2>
            <div style={{ color: "#7a715f", fontSize: 12, marginTop: 2 }}>
              AM: {row.am_name ?? "—"} · run {row.run_date}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "1px solid rgba(45,72,67,0.18)",
              background: "transparent",
              padding: "4px 10px",
              borderRadius: 999,
              cursor: "pointer",
              color: "var(--ink, #2D4843)",
            }}
          >
            ✕
          </button>
        </header>

        <section style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 11, letterSpacing: 0.6, color: "#7a715f", textTransform: "uppercase" }}>
              Engine
            </div>
            <div style={{ marginTop: 4 }}>
              <TierPill tier={row.deterministic_tier} />{" "}
              <span style={{ fontSize: 12, color: "#7a715f" }}>
                comp {row.deterministic_composite}
              </span>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, letterSpacing: 0.6, color: "#7a715f", textTransform: "uppercase" }}>
              LLM
            </div>
            <div style={{ marginTop: 4 }}>
              <TierPill tier={row.llm_tier} />{" "}
              <span style={{ fontSize: 12, color: "#7a715f" }}>
                conf {row.llm_confidence}
                {row.llm_disagreement_self_flag ? " · self-flagged" : ""}
              </span>
            </div>
          </div>
          <div style={{ marginLeft: "auto", fontSize: 12, color: "#7a715f" }}>
            {row.llm_retention_window_months != null
              ? `${row.llm_retention_window_months}mo retention`
              : "retention: —"}
          </div>
        </section>

        <section>
          <div style={{ fontSize: 11, letterSpacing: 0.6, color: "#7a715f", textTransform: "uppercase", marginBottom: 6 }}>
            Reasoning
          </div>
          <div style={{ color: "var(--ink, #2D4843)", lineHeight: 1.55, fontSize: 13 }}>
            {row.llm_reasoning}
          </div>
        </section>

        {signals.length > 0 ? (
          <section>
            <div style={{ fontSize: 11, letterSpacing: 0.6, color: "#7a715f", textTransform: "uppercase", marginBottom: 6 }}>
              Key signals
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, color: "var(--ink, #2D4843)", fontSize: 13, lineHeight: 1.55 }}>
              {signals.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {row.deterministic_signal_summary ? (
          <section>
            <div style={{ fontSize: 11, letterSpacing: 0.6, color: "#7a715f", textTransform: "uppercase", marginBottom: 6 }}>
              Engine chips (today)
            </div>
            <code
              style={{
                display: "block",
                fontSize: 11,
                color: "#7a3a0d",
                background: "rgba(168,90,26,0.08)",
                padding: "8px 10px",
                borderRadius: 6,
              }}
            >
              {row.deterministic_signal_summary}
            </code>
          </section>
        ) : null}

        <section>
          <div style={{ fontSize: 11, letterSpacing: 0.6, color: "#7a715f", textTransform: "uppercase", marginBottom: 6 }}>
            Last 28 days
          </div>
          {!history ? (
            <div style={{ color: "#7a715f", fontSize: 12 }}>Loading history…</div>
          ) : history.history.length === 0 ? (
            <div style={{ color: "#7a715f", fontSize: 12 }}>No prior verdicts.</div>
          ) : (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {history.history.map((h) => (
                <div
                  key={h.run_date}
                  title={`${h.run_date} · engine ${h.deterministic_tier} · llm ${h.llm_tier}`}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 4,
                    background: h.agreement
                      ? TIER_TONE[h.llm_tier].bg
                      : "repeating-linear-gradient(45deg, rgba(196,73,73,0.18) 0 4px, rgba(217,168,56,0.18) 4px 8px)",
                    border: h.agreement
                      ? "1px solid rgba(45,72,67,0.15)"
                      : "1px solid rgba(196,73,73,0.5)",
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
