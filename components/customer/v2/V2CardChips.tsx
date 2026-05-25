"use client";

/**
 * V2CardChips — Phase E-15.4b extraction.
 *
 * The chip pile from V2CustomerCard. Four near-pure components + one helper:
 *
 *   FlagChip               — single amber-on-amber pill
 *   SignalChipRow          — RED/YELLOW negative signals OR GREEN positives
 *   ActionChip             — connected/vm/no-reach action button
 *   performanceChipSummary — helper that produces the short string for ⚑ chip
 *
 * All four were inlined in V2CustomerCard, pushing it past 1800 lines. They
 * have no coupling to the card's state machine — just props in, JSX out.
 * Extracting them removes ~200 lines from V2CustomerCard.
 */

import * as React from "react";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import type { SignalKey } from "@/lib/customer/signal-taxonomy";

export function FlagChip({
  label,
  onClick,
}: {
  label: string;
  onClick?: () => void;
}) {
  const base =
    "rounded-zoca-sm bg-amber-500/18 px-2 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-500/30";
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${base} v2-chip-clickable`}
        title={`Filter to: ${label}`}
        aria-label={`Filter to ${label}`}
      >
        {label}
      </button>
    );
  }
  return <span className={base}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Phase 22.B.1 + Phase 26 — SignalChipRow.
// Tier-aware: RED/YELLOW render negative signal chips at the existing
// thresholds in their respective tones, and GREEN renders positive chips
// (ACTIVE COMMS / APP STRONG / LEADS UP / REVIEWS ON TRACK).
// ---------------------------------------------------------------------------

export type ChipTone = "RED" | "YELLOW" | "GREEN";

export function SignalChipRow({
  customer,
  onChipClick,
  tone,
}: {
  customer: ScoredCustomerV2;
  onChipClick: (key: SignalKey) => void;
  tone: ChipTone;
}) {
  const s = customer.signals_v2;
  const { metrics } = customer;

  // Negative signals (used on RED + YELLOW)
  const negativeActive: { key: SignalKey; label: string }[] = [];
  if ((s.sig_client_silent ?? 0) >= 65)
    negativeActive.push({ key: "client_silent", label: "Client silent" });
  if ((s.sig_we_silent ?? 0) >= 65)
    negativeActive.push({ key: "we_silent", label: "We silent" });
  if ((s.sig_response_drop ?? 0) >= 65)
    negativeActive.push({ key: "resp_drop", label: "Resp drop" });
  if ((s.sig_volume_collapse ?? 0) >= 55)
    negativeActive.push({ key: "vol_collapse", label: "Vol collapse" });
  if ((s.sig_usage ?? 0) >= 55)
    negativeActive.push({ key: "usage_low", label: "Usage low" });
  if ((s.sig_billing ?? 0) >= 40)
    negativeActive.push({ key: "billing", label: "Billing" });

  // Positive signals (used on GREEN when no negatives are active)
  const positiveActive: { label: string }[] = [];
  if (metrics.total_30d >= 8) {
    positiveActive.push({ label: "Active comms" });
  }
  if (customer.usage?.engagement_tier === "Active") {
    positiveActive.push({ label: "App strong" });
  }
  if (
    customer.performance?.ytd_leads_change_pct !== null &&
    customer.performance?.ytd_leads_change_pct !== undefined &&
    customer.performance.ytd_leads_change_pct >= 20
  ) {
    positiveActive.push({ label: "Leads up" });
  }
  if (
    customer.performance?.weeks_with_zero_reviews !== null &&
    customer.performance?.weeks_with_zero_reviews !== undefined &&
    customer.performance.weeks_with_zero_reviews <= 2
  ) {
    positiveActive.push({ label: "Reviews on track" });
  }

  // Choose what to render based on tone + activity
  let chipsToRender: React.ReactNode[] = [];
  if (tone === "GREEN") {
    // GREEN: surface positives. If none, render nothing.
    if (positiveActive.length === 0) return null;
    chipsToRender = positiveActive.map((c, i) => (
      <span
        key={`pos-${i}`}
        className="rounded-full bg-emerald-500/12 px-[11px] py-[4px] text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-700 ring-1 ring-emerald-500/25"
        title={c.label}
      >
        {c.label}
      </span>
    ));
  } else {
    // RED / YELLOW: surface negatives.
    if (negativeActive.length === 0) return null;
    const chipClass =
      tone === "RED"
        ? "v2-chip-clickable rounded-full bg-zoca-pink/12 px-[11px] py-[4px] text-[10px] font-semibold uppercase tracking-[0.08em] text-zoca-pink-bright ring-1 ring-zoca-pink/25"
        : "v2-chip-clickable rounded-full bg-amber-500/12 px-[11px] py-[4px] text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700 ring-1 ring-amber-500/25";
    chipsToRender = negativeActive.map((c) => (
      <button
        key={c.key}
        type="button"
        onClick={() => onChipClick(c.key)}
        className={chipClass}
        title={`Filter book to: ${c.label}`}
        aria-label={`Filter book to ${c.label}`}
      >
        {c.label}
      </button>
    ));
  }

  return <div className="mt-2 flex flex-wrap gap-1.5">{chipsToRender}</div>;
}

// ---------------------------------------------------------------------------
// ActionChip — connected / VM / noreach contact-result chips.
// ---------------------------------------------------------------------------

export function ActionChip({
  label,
  tone,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  tone: "emerald" | "amber" | "rose";
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const toneClass =
    tone === "emerald"
      ? "border-emerald-400/40 bg-emerald-500/18 text-emerald-700 hover:bg-emerald-500/25"
      : tone === "amber"
        ? "border-amber-400/40 bg-amber-500/18 text-amber-700 hover:bg-amber-500/25"
        : "border-zoca-pink/40 bg-zoca-pink/18 text-zoca-pink-bright hover:bg-zoca-pink/25";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-zoca-pill border px-2 py-1 text-[11px] font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40 ${toneClass} ${
        disabled ? "cursor-not-allowed opacity-50" : ""
      } ${busy ? "animate-pulse" : ""}`}
      aria-label={`Log contact result: ${label}`}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// performanceChipSummary — produces the short "⚑ GBP ▼32% · 5wk zero"
// label for the performance trajectory pill. Pure string transform.
// ---------------------------------------------------------------------------

export function performanceChipSummary(
  p: NonNullable<ScoredCustomerV2["performance"]>,
): string | null {
  if (!p.flag) return null;
  const parts: string[] = [];
  if (p.gbp_clicks_drop_pct !== null && p.gbp_clicks_drop_pct >= 25) {
    parts.push(`GBP ▼${Math.round(p.gbp_clicks_drop_pct)}%`);
  }
  if (p.weeks_with_zero_reviews !== null && p.weeks_with_zero_reviews >= 4) {
    parts.push(`${p.weeks_with_zero_reviews}wk zero`);
  }
  if (p.ytd_leads_change_pct !== null && p.ytd_leads_change_pct <= -20) {
    parts.push(`YTD ▼${Math.abs(Math.round(p.ytd_leads_change_pct))}%`);
  }
  if (!parts.length) return null;
  return parts.slice(0, 2).join(" · ");
}

export type ActionChoice = "connected" | "vm" | "noreach";
