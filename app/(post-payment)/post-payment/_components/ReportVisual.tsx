"use client";

/**
 * ReportVisual — interactive visual representation of a generated post-payment
 * review. Reads the canonical report JSON and renders an animated tabbed UI:
 *   • Overview — drivers / reinforcing flags / mitigating factors columns
 *   • Module 02 — Step 1 / Step 2 / disqualifier checks with pass/fail badges
 *   • Risks — risk register cards with likelihood × impact heatmap
 *   • Pointers — five investigative pointers from the analysis
 *
 * Mirrors the dashboard's animation language (anim-rise / chart-card lift /
 * count-up / donut fade-in / shimmer on active tab).
 */

import { useEffect, useMemo, useRef, useState } from "react";

type Status = "PASS" | "FAIL" | "AUTOFAIL" | "WARN" | "GAP" | string;

type Step = { gate: string; status: Status; evidence: any };
type RuleRow = { rule: string; status: Status; evidence: any };
type Disqualifier = { label: string; status: Status; evidence: any };
type Risk = { id: string; risk: string; likelihood: Status; impact: Status; driver_mitigation: string };
type Pointer = { title: string; source?: string; signal?: string; signal_status?: Status; blocks?: any[] };

type ReportData = {
  exec?: {
    verdict_label?: string;
    verdict_status?: string;
    recommended_action_label?: string;
    driver?: string;
    reinforcing_flags?: string;
    mitigating_factors?: string;
    summary_paragraphs?: string[];
    net_retention_picture?: string;
    likely_outcome?: string;
  };
  qualitative_flags?: { items?: { flag: string; severity?: Status; detail?: string }[]; intro?: string };
  section3_risks?: { intro?: string; risks?: Risk[] };
  section4_framework?: {
    tier_application?: string;
    vertical_lock_text?: string;
    step1?: Step[];
    step1_conclusion?: string;
    step2_row_label?: string;
    step2?: RuleRow[];
    disqualifiers?: Disqualifier[];
    summary_table?: { layer: string; status: Status; detail: string }[];
    summary_takeaway?: string;
    one_line_blockquote?: string;
  };
  section5_pointers?: Pointer[];
};

/* ──────────────────────────────────────────────
   Helpers — status colors + count-up tween
   ────────────────────────────────────────────── */
function statusColor(status: Status): { bg: string; border: string; text: string; dot: string } {
  // Watchfire status palette — replaces v2 emerald/red/amber/purple hex codes
  // that were leaking into the report visual. Each tier maps to a Watchfire
  // hue: PASS=Patina, FAIL=Deep Crimson, WARN=Brass, GAP=Smoke, default=Buff.
  // Backgrounds are 10-12% tints, borders 35-40% to stay on-palette.
  const s = (status ?? "").toUpperCase();
  if (s === "PASS")
    return { bg: "rgba(74, 124, 89, 0.10)", border: "rgba(74, 124, 89, 0.35)", text: "#2D5A3A", dot: "#4A7C59" };
  if (s === "FAIL" || s === "AUTOFAIL")
    return { bg: "rgba(124, 45, 18, 0.10)", border: "rgba(124, 45, 18, 0.35)", text: "#7C2D12", dot: "#7C2D12" };
  if (s === "WARN")
    return { bg: "rgba(217, 164, 65, 0.12)", border: "rgba(217, 164, 65, 0.40)", text: "#8C6A1F", dot: "#D9A441" };
  if (s === "GAP")
    return { bg: "rgba(110, 95, 80, 0.10)", border: "rgba(110, 95, 80, 0.30)", text: "#5A4C3E", dot: "#8B7A66" };
  return { bg: "#EBE0C2", border: "#D4C29B", text: "#6E5F50", dot: "#8B7A66" };
}

function statusIcon(status: Status): string {
  const s = (status ?? "").toUpperCase();
  if (s === "PASS") return "✓";
  if (s === "FAIL" || s === "AUTOFAIL") return "✕";
  if (s === "WARN") return "⚠";
  if (s === "GAP") return "?";
  return "·";
}

function useCountUp(target: number, duration = 900, delay = 0): number {
  const [val, setVal] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current;
    const to = target;
    let raf = 0;
    const start = performance.now() + delay;
    const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
    const tick = (now: number) => {
      if (now < start) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const t = Math.min(1, (now - start) / duration);
      setVal(from + (to - from) * easeOutQuint(t));
      if (t < 1) raf = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, delay]);
  return Math.round(val);
}

function AnimatedNumber({ value, delay = 0 }: { value: number; delay?: number }) {
  const v = useCountUp(value, 900, delay);
  return <span className="count-up" style={{ animationDelay: `${delay}ms` }}>{v}</span>;
}

/* ──────────────────────────────────────────────
   StatusPill — pass/fail/warn/gap chip
   ────────────────────────────────────────────── */
function StatusPill({ status, label }: { status: Status; label?: string }) {
  const c = statusColor(status);
  const display = label ?? (status ?? "").toUpperCase();
  return (
    <span
      className="verdict-pill inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold"
      style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }}
    >
      <span aria-hidden style={{ display: "inline-block", width: 14, height: 14, lineHeight: "14px", textAlign: "center", borderRadius: "50%", background: c.dot, color: "#fff", fontSize: 10 }}>
        {statusIcon(status)}
      </span>
      {display}
    </span>
  );
}

/* ──────────────────────────────────────────────
   StatusDonut — counts up by status across an array
   ────────────────────────────────────────────── */
function StatusDonut({
  items,
  total,
}: {
  items: { label: string; value: number; color: string }[];
  total?: number;
}) {
  const sum = total ?? items.reduce((a, b) => a + b.value, 0);
  const r = 52;
  const stroke = 18;
  const C = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", height: 140 }}>
      <svg width={140} height={140} viewBox="0 0 160 160">
        <circle cx={80} cy={80} r={r} fill="none" stroke="#F3F4F6" strokeWidth={stroke} />
        {items.map((d, idx) => {
          if (d.value === 0) return null;
          const pct = d.value / Math.max(sum, 1);
          const len = pct * C;
          const offset = -acc * C;
          acc += pct;
          return (
            <circle
              key={d.label}
              className="donut-ring"
              cx={80}
              cy={80}
              r={r}
              fill="none"
              stroke={d.color}
              strokeWidth={stroke}
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={offset}
              transform="rotate(-90 80 80)"
              style={{ animationDelay: `${0.25 + idx * 0.08}s` }}
            />
          );
        })}
      </svg>
      <div className="donut-center" style={{ position: "absolute", textAlign: "center", pointerEvents: "none" }}>
        <div style={{ fontSize: 10, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5 }}>Items</div>
        <div style={{ fontSize: 26, fontWeight: 700, color: "#0A2540", lineHeight: 1.1 }}>
          <AnimatedNumber value={sum} delay={400} />
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────
   TabBar — animated active state with shimmer
   ────────────────────────────────────────────── */
type TabKey = "overview" | "framework" | "risks" | "pointers";
function TabBar({
  active,
  onSelect,
  counts,
}: {
  active: TabKey;
  onSelect: (k: TabKey) => void;
  counts: { framework: number; risks: number; pointers: number };
}) {
  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "framework", label: "Module 02 Framework", count: counts.framework },
    { key: "risks", label: "Risk Register", count: counts.risks },
    { key: "pointers", label: "Investigative Pointers", count: counts.pointers },
  ];
  return (
    <div className="flex flex-wrap gap-2 border-b border-line pb-2">
      {tabs.map((t) => {
        const isActive = active === t.key;
        return (
          <button
            key={t.key}
            onClick={() => onSelect(t.key)}
            className={`btn-bounce relative inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition ${
              isActive
                ? "stat-card-active text-accent-blue-strong"
                : "text-ink-muted hover:text-ink hover:bg-elevated"
            }`}
            style={{
              border: isActive ? "1px solid rgba(45, 91, 255, 0.4)" : "1px solid transparent",
              background: isActive ? "rgba(239, 246, 255, 0.6)" : undefined,
            }}
          >
            <span style={{ position: "relative", zIndex: 1 }}>{t.label}</span>
            {typeof t.count === "number" && (
              <span
                className="tabular-nums text-xs px-1.5 rounded-full"
                style={{
                  position: "relative",
                  zIndex: 1,
                  background: isActive ? "rgba(45, 91, 255, 0.15)" : "#F3F4F6",
                  color: isActive ? "#1E40AF" : "#6B7280",
                }}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────
   Overview — three-column driver / flags / mitigants
   ────────────────────────────────────────────── */
function Overview({ exec, qualitative }: { exec: ReportData["exec"]; qualitative: ReportData["qualitative_flags"] }) {
  // Watchfire overview cards — Driver = Deep Crimson (decisive cause),
  // Reinforcing flags = Brass (signals to corroborate), Mitigating = Patina
  // (the green-on-green Watchfire stand-in for "looks OK").
  const cards = [
    { label: "Driving factor", body: exec?.driver, accent: "#7C2D12", bg: "rgba(124, 45, 18, 0.06)" },
    { label: "Reinforcing flags", body: exec?.reinforcing_flags, accent: "#D9A441", bg: "rgba(217, 164, 65, 0.08)" },
    { label: "Mitigating factors", body: exec?.mitigating_factors, accent: "#4A7C59", bg: "rgba(74, 124, 89, 0.08)" },
  ].filter((c) => c.body);

  return (
    <div className="space-y-6">
      {cards.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 anim-cascade items-stretch">
          {cards.map((c) => (
            <div
              key={c.label}
              className="chart-card rounded-2xl p-5 border flex flex-col"
              style={{ background: c.bg, borderColor: `${c.accent}33` }}
            >
              <div className="flex items-center gap-2 mb-2">
                <span style={{ width: 8, height: 8, background: c.accent, borderRadius: 2, display: "inline-block" }} />
                <span className="text-xs uppercase tracking-wide font-semibold" style={{ color: c.accent }}>{c.label}</span>
              </div>
              <p className="text-sm text-ink-muted leading-relaxed">{c.body}</p>
            </div>
          ))}
        </div>
      )}

      {qualitative?.items && qualitative.items.length > 0 && (
        <div className="rounded-2xl border border-line bg-surface p-5 anim-rise" style={{ animationDelay: "0.20s" }}>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-ink uppercase tracking-wide">Qualitative red flags</h4>
            <span className="text-xs text-ink-dim">{qualitative.items.length} flag{qualitative.items.length !== 1 ? "s" : ""}</span>
          </div>
          {qualitative.intro && <p className="text-sm text-ink-muted mb-3">{qualitative.intro}</p>}
          <ul className="space-y-2.5">
            {qualitative.items.map((it, idx) => (
              <li key={idx} className="anim-rise flex gap-3 items-start" style={{ animationDelay: `${0.22 + idx * 0.05}s` }}>
                <StatusPill status={it.severity ?? "WARN"} label={(it.severity ?? "FLAG").toUpperCase()} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-ink">{it.flag}</div>
                  {it.detail && <div className="text-xs text-ink-muted mt-1">{it.detail}</div>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {exec?.summary_paragraphs && exec.summary_paragraphs.length > 0 && (
        <SummaryParagraphs paragraphs={exec.summary_paragraphs} />
      )}

      {(exec?.net_retention_picture || exec?.likely_outcome) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 anim-cascade items-stretch">
          {exec.net_retention_picture && (
            <div className="chart-card rounded-2xl border border-line bg-surface p-5 flex flex-col">
              <div className="text-xs text-ink-dim uppercase tracking-wide font-semibold mb-2">Net retention picture</div>
              <p className="text-sm text-ink-muted leading-relaxed">{exec.net_retention_picture}</p>
            </div>
          )}
          {exec.likely_outcome && (
            <div className="chart-card rounded-2xl border border-line bg-surface p-5 flex flex-col">
              <div className="text-xs text-ink-dim uppercase tracking-wide font-semibold mb-2">Likely outcome</div>
              <p className="text-sm text-ink-muted leading-relaxed">{exec.likely_outcome}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryParagraphs({ paragraphs }: { paragraphs: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? paragraphs : paragraphs.slice(0, 1);
  return (
    <div className="rounded-2xl border border-line bg-surface p-5 anim-rise" style={{ animationDelay: "0.28s" }}>
      <div className="text-xs text-ink-dim uppercase tracking-wide font-semibold mb-3">Executive summary</div>
      <div className="space-y-3 text-sm text-ink-muted leading-relaxed">
        {visible.map((p, i) => (
          <p key={i} className="anim-rise" style={{ animationDelay: `${0.30 + i * 0.05}s` }}>{p}</p>
        ))}
      </div>
      {paragraphs.length > 1 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="btn-bounce mt-4 text-xs text-accent-blue hover:text-accent-blue-strong font-medium"
        >
          {expanded ? "Show less ↑" : `Show ${paragraphs.length - 1} more paragraph${paragraphs.length - 1 !== 1 ? "s" : ""} ↓`}
        </button>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────
   Framework — Step 1, Step 2, Disqualifiers
   ────────────────────────────────────────────── */
function Framework({ framework }: { framework: ReportData["section4_framework"] }) {
  if (!framework) return <Empty label="No framework data" />;

  // Status mix for the summary donut
  const allStatuses = [
    ...(framework.step1 ?? []).map((s) => s.status),
    ...(framework.step2 ?? []).map((s) => s.status),
    ...(framework.disqualifiers ?? []).map((s) => s.status),
  ];
  const counts = {
    pass: allStatuses.filter((s) => (s ?? "").toUpperCase() === "PASS").length,
    fail: allStatuses.filter((s) => ["FAIL", "AUTOFAIL"].includes((s ?? "").toUpperCase())).length,
    warn: allStatuses.filter((s) => (s ?? "").toUpperCase() === "WARN").length,
    gap: allStatuses.filter((s) => (s ?? "").toUpperCase() === "GAP").length,
  };
  // Donut wedges in Watchfire — same hues as the status pills above so the
  // chart and table cross-reference visually.
  const donutData = [
    { label: "Pass", value: counts.pass, color: "#4A7C59" },     // Patina
    { label: "Fail", value: counts.fail, color: "#7C2D12" },     // Deep Crimson
    { label: "Warn", value: counts.warn, color: "#D9A441" },     // Brass
    { label: "Gap", value: counts.gap, color: "#8B7A66" },       // Faded Smoke
  ];

  return (
    <div className="space-y-6">
      {/* SUMMARY ROW — donut + tier text + vertical lock (equal-height) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 anim-cascade items-stretch">
        <div className="chart-card rounded-2xl border border-line bg-surface p-5 flex flex-col">
          <div className="text-xs text-ink-dim uppercase tracking-wide font-semibold mb-1">Check distribution</div>
          <StatusDonut items={donutData} />
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-auto pt-3 text-xs">
            {donutData.map((d) => (
              <div key={d.label} className="flex items-center gap-2">
                <span style={{ display: "inline-block", width: 8, height: 8, background: d.color, borderRadius: 2 }} />
                <span className="text-ink-muted">{d.label}</span>
                <span className="ml-auto text-ink-dim tabular-nums">{d.value}</span>
              </div>
            ))}
          </div>
        </div>
        {framework.tier_application && (
          <div className="chart-card rounded-2xl border border-line bg-surface p-5 flex flex-col">
            <div className="text-xs text-ink-dim uppercase tracking-wide font-semibold mb-2">Tier application (Step 1.2)</div>
            <p className="text-sm text-ink-muted leading-relaxed">{framework.tier_application}</p>
          </div>
        )}
        {framework.vertical_lock_text && (
          <div className="chart-card rounded-2xl border border-line bg-surface p-5 flex flex-col">
            <div className="text-xs text-ink-dim uppercase tracking-wide font-semibold mb-2">Vertical lock</div>
            <p className="text-sm text-ink-muted leading-relaxed">{framework.vertical_lock_text}</p>
          </div>
        )}
      </div>

      {/* STEP 1 — three gates as flow (equal-height) */}
      {framework.step1 && framework.step1.length > 0 && (
        <FrameworkBlock title="Step 1 — three hard rules" subtitle={framework.step1_conclusion} delay={0.18}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-stretch">
            {framework.step1.map((s, idx) => (
              <GateCard key={idx} gate={s.gate} status={s.status} evidence={s.evidence} idx={idx} />
            ))}
          </div>
        </FrameworkBlock>
      )}

      {/* STEP 2 — row label + rule A/B */}
      {framework.step2 && framework.step2.length > 0 && (
        <FrameworkBlock
          title={`Step 2 — ${framework.step2_row_label ?? "lead-shape row"}`}
          subtitle={undefined}
          delay={0.24}
        >
          <div className="space-y-2.5">
            {framework.step2.map((s, idx) => (
              <RuleCard key={idx} rule={s.rule} status={s.status} evidence={s.evidence} idx={idx} />
            ))}
          </div>
        </FrameworkBlock>
      )}

      {/* DISQUALIFIERS */}
      {framework.disqualifiers && framework.disqualifiers.length > 0 && (
        <FrameworkBlock title="Additional disqualifiers" subtitle={undefined} delay={0.30}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 items-stretch">
            {framework.disqualifiers.map((d, idx) => (
              <DisqualifierRow key={idx} label={d.label} status={d.status} evidence={d.evidence} idx={idx} />
            ))}
          </div>
        </FrameworkBlock>
      )}

      {/* TAKEAWAY */}
      {(framework.summary_takeaway || framework.one_line_blockquote) && (
        <div className="rounded-2xl border border-accent-blue/30 bg-accent-blue-bg/40 p-5 anim-rise" style={{ animationDelay: "0.40s" }}>
          {framework.one_line_blockquote && (
            <blockquote className="text-sm italic text-accent-blue-strong border-l-2 border-accent-blue pl-3 mb-3">
              {framework.one_line_blockquote}
            </blockquote>
          )}
          {framework.summary_takeaway && <p className="text-sm text-ink leading-relaxed">{framework.summary_takeaway}</p>}
        </div>
      )}
    </div>
  );
}

function FrameworkBlock({ title, subtitle, delay, children }: { title: string; subtitle?: string; delay: number; children: React.ReactNode }) {
  return (
    <div className="anim-rise" style={{ animationDelay: `${delay}s` }}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h4 className="text-sm font-semibold text-ink uppercase tracking-wide">{title}</h4>
        {subtitle && <span className="text-xs text-ink-dim">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function GateCard({ gate, status, evidence, idx }: { gate: string; status: Status; evidence: any; idx: number }) {
  const [open, setOpen] = useState(false);
  const c = statusColor(status);
  return (
    <div
      onClick={() => setOpen(!open)}
      className="chart-card rounded-xl p-4 cursor-pointer border anim-rise flex flex-col h-full"
      style={{ background: c.bg, borderColor: c.border, animationDelay: `${0.22 + idx * 0.06}s` }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="text-xs font-semibold text-ink leading-snug">{gate}</div>
        <StatusPill status={status} />
      </div>
      {evidence && (
        <button className="text-xs text-ink-dim hover:text-accent-blue mt-auto pt-1 text-left">
          {open ? "Hide evidence ↑" : "Show evidence ↓"}
        </button>
      )}
      {open && evidence && (
        <div className="mt-2 text-xs text-ink-muted leading-relaxed">
          <EvidenceRenderer ev={evidence} />
        </div>
      )}
    </div>
  );
}

function RuleCard({ rule, status, evidence, idx }: { rule: string; status: Status; evidence: any; idx: number }) {
  const [open, setOpen] = useState(false);
  const c = statusColor(status);
  return (
    <div
      onClick={() => setOpen(!open)}
      className="rounded-xl border p-3 cursor-pointer flex items-start justify-between gap-3 hover:bg-elevated transition anim-rise"
      style={{ borderColor: c.border, animationDelay: `${0.28 + idx * 0.06}s` }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-ink">{rule}</div>
        {open && evidence && (
          <div className="mt-2 text-xs text-ink-muted leading-relaxed">
            <EvidenceRenderer ev={evidence} />
          </div>
        )}
      </div>
      <StatusPill status={status} />
    </div>
  );
}

function DisqualifierRow({ label, status, evidence, idx }: { label: string; status: Status; evidence: any; idx: number }) {
  const c = statusColor(status);
  return (
    <div
      className="rounded-lg border p-2.5 flex items-center justify-between gap-3 anim-rise"
      style={{ borderColor: c.border, background: c.bg, animationDelay: `${0.32 + idx * 0.04}s` }}
      title={typeof evidence === "string" ? evidence : ""}
    >
      <span className="text-xs text-ink-muted">{label}</span>
      <StatusPill status={status} />
    </div>
  );
}

function EvidenceRenderer({ ev }: { ev: any }) {
  if (typeof ev === "string") return <p>{ev}</p>;
  if (Array.isArray(ev)) {
    return (
      <div className="space-y-1.5">
        {ev.map((b: any, i: number) => {
          if (typeof b === "string") return <p key={i}>{b}</p>;
          if (b?.type === "para" || b?.type === "richpara") return <p key={i}>{b.text ?? (b.runs ?? []).map((r: any) => r.text).join("")}</p>;
          if (b?.type === "bullet") return <p key={i}>• {b.text}</p>;
          if (b?.type === "h3") return <p key={i} className="font-semibold text-ink">{b.text}</p>;
          return null;
        })}
      </div>
    );
  }
  return null;
}

/* ──────────────────────────────────────────────
   Risk register
   ────────────────────────────────────────────── */
function RiskRegister({ section }: { section: ReportData["section3_risks"] }) {
  if (!section?.risks || section.risks.length === 0) return <Empty label="No risks recorded" />;

  // Sort by severity (FAIL/AUTOFAIL > WARN > others)
  const severityRank = (s: Status) => {
    const u = (s ?? "").toUpperCase();
    if (u === "FAIL" || u === "AUTOFAIL") return 0;
    if (u === "WARN") return 1;
    if (u === "GAP") return 2;
    return 3;
  };
  const sorted = [...section.risks].sort((a, b) => {
    const ra = severityRank(a.likelihood) + severityRank(a.impact);
    const rb = severityRank(b.likelihood) + severityRank(b.impact);
    return ra - rb;
  });

  return (
    <div className="space-y-4">
      {section.intro && (
        <p className="text-sm text-ink-muted leading-relaxed anim-rise" style={{ animationDelay: "0.10s" }}>{section.intro}</p>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 anim-cascade items-stretch">
        {sorted.map((r, idx) => (
          <RiskCard key={r.id} risk={r} idx={idx} />
        ))}
      </div>
    </div>
  );
}

function RiskCard({ risk, idx }: { risk: Risk; idx: number }) {
  const [open, setOpen] = useState(false);
  const lc = statusColor(risk.likelihood);
  const ic = statusColor(risk.impact);
  // Combined severity color — pick the darker of the two
  const combinedSev = [risk.likelihood, risk.impact].some((s) => ["FAIL", "AUTOFAIL"].includes((s ?? "").toUpperCase())) ? "fail"
    : [risk.likelihood, risk.impact].some((s) => (s ?? "").toUpperCase() === "WARN") ? "warn"
    : "gap";
  // Risk card severity stripe — Watchfire palette: Deep Crimson for fail,
  // Brass for warn, Smoke for gap/info. Replaces v2 red/amber/purple hex.
  const sevAccent = combinedSev === "fail" ? "#7C2D12" : combinedSev === "warn" ? "#D9A441" : "#8B7A66";
  return (
    <div
      onClick={() => setOpen(!open)}
      className="chart-card rounded-xl border border-line bg-surface p-4 cursor-pointer flex flex-col h-full"
      style={{ borderLeft: `3px solid ${sevAccent}` }}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-xs text-ink-dim font-mono">{risk.id}</div>
          <div className="text-sm font-semibold text-ink">{risk.risk}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mb-2">
        <span className="inline-flex items-center gap-1 text-xs">
          <span className="text-ink-dim">Likelihood</span>
          <StatusPill status={risk.likelihood} />
        </span>
        <span className="inline-flex items-center gap-1 text-xs">
          <span className="text-ink-dim">Impact</span>
          <StatusPill status={risk.impact} />
        </span>
      </div>
      <p className="text-xs text-ink-muted leading-relaxed" style={{ maxHeight: open ? 800 : 42, overflow: "hidden", transition: "max-height 320ms cubic-bezier(0.16, 1, 0.3, 1)" }}>
        {risk.driver_mitigation}
      </p>
      {risk.driver_mitigation.length > 100 && (
        <button className="text-xs text-accent-blue hover:text-accent-blue-strong mt-2 font-medium">
          {open ? "Collapse ↑" : "Read more ↓"}
        </button>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────
   Pointers
   ────────────────────────────────────────────── */
function Pointers({ pointers }: { pointers?: Pointer[] }) {
  if (!pointers || pointers.length === 0) return <Empty label="No pointers" />;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 anim-cascade items-stretch">
      {pointers.map((p, idx) => <PointerCard key={idx} pointer={p} idx={idx} />)}
    </div>
  );
}

function PointerCard({ pointer, idx }: { pointer: Pointer; idx: number }) {
  const [open, setOpen] = useState(false);
  const c = pointer.signal_status ? statusColor(pointer.signal_status) : statusColor("GAP");
  return (
    <div
      onClick={() => setOpen(!open)}
      className="chart-card rounded-xl border border-line bg-surface p-4 cursor-pointer flex flex-col h-full"
      style={{ borderTop: `3px solid ${c.dot}` }}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="text-sm font-semibold text-ink flex-1">{pointer.title}</div>
        {pointer.signal_status && <StatusPill status={pointer.signal_status} />}
      </div>
      {pointer.signal && <div className="text-xs text-ink-muted mb-1">{pointer.signal}</div>}
      {pointer.source && <div className="text-[10px] text-ink-faint font-mono">{pointer.source}</div>}
      {open && pointer.blocks && (
        <div className="mt-3 text-xs text-ink-muted leading-relaxed border-t border-line-soft pt-3">
          <EvidenceRenderer ev={pointer.blocks} />
        </div>
      )}
      {pointer.blocks && pointer.blocks.length > 0 && (
        <button className="text-xs text-accent-blue hover:text-accent-blue-strong mt-2 font-medium">
          {open ? "Collapse ↑" : "Show evidence ↓"}
        </button>
      )}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-2xl border border-line bg-elevated p-8 text-center text-ink-dim text-sm">
      {label}
    </div>
  );
}

/* ──────────────────────────────────────────────
   MAIN ENTRY
   ────────────────────────────────────────────── */
export default function ReportVisual({ data }: { data: ReportData }) {
  const [tab, setTab] = useState<TabKey>("overview");

  const counts = useMemo(() => ({
    framework:
      (data.section4_framework?.step1?.length ?? 0) +
      (data.section4_framework?.step2?.length ?? 0) +
      (data.section4_framework?.disqualifiers?.length ?? 0),
    risks: data.section3_risks?.risks?.length ?? 0,
    pointers: data.section5_pointers?.length ?? 0,
  }), [data]);

  return (
    <div className="space-y-5">
      <TabBar active={tab} onSelect={setTab} counts={counts} />
      <div className="pt-2">
        {tab === "overview" && <Overview exec={data.exec} qualitative={data.qualitative_flags} />}
        {tab === "framework" && <Framework framework={data.section4_framework} />}
        {tab === "risks" && <RiskRegister section={data.section3_risks} />}
        {tab === "pointers" && <Pointers pointers={data.section5_pointers} />}
      </div>
    </div>
  );
}
