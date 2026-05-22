"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (0 hex/rgba + 3 tailwind-rose swept)

import * as React from "react";
import { createPortal } from "react-dom";
import type { ScoredCustomerV2 } from "@/lib/customer/types";

import { normalizeHealthTier, HEALTH_TIER_COLORS, HEALTH_TIER_LABELS } from "@/lib/customer/config";
type Props = {
  customer: ScoredCustomerV2;
  anchorRef: React.RefObject<HTMLElement>;
  visible: boolean;
  onClose: () => void;
};

type Position = {
  top: number;
  left: number;
  placement: "above" | "below";
};

const POPOVER_WIDTH = 320;
const POPOVER_GAP = 8;
const MIN_TOP_PADDING = 200; // fall back to below if anchor is too close to top

/**
 * Phase 32 — V2HoverPreview.
 *
 * Floating popover surfacing a 1-glance peek of a customer card. Mounted
 * via React Portal so it escapes the card's stacking context and overflow
 * containers. Positions itself ABOVE the anchor when there's room,
 * otherwise BELOW.
 */
export default function V2HoverPreview({ customer, anchorRef, visible, onClose }: Props) {
  const [mounted, setMounted] = React.useState(false);
  const [pos, setPos] = React.useState<Position | null>(null);
  const popoverRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Compute position whenever visibility flips on.
  React.useEffect(() => {
    if (!visible || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const placement: "above" | "below" =
      rect.top < MIN_TOP_PADDING ? "below" : "above";
    const left = Math.max(
      8,
      Math.min(
        window.innerWidth - POPOVER_WIDTH - 8,
        rect.left + rect.width / 2 - POPOVER_WIDTH / 2,
      ),
    );
    setPos({
      top:
        placement === "above"
          ? rect.top + window.scrollY - POPOVER_GAP
          : rect.bottom + window.scrollY + POPOVER_GAP,
      left: left + window.scrollX,
      placement,
    });
  }, [visible, anchorRef]);

  // Esc closes.
  React.useEffect(() => {
    if (!visible) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, onClose]);

  if (!mounted || !visible || !pos) return null;

  const s = customer.signals_v2;
  // Phase 33.E.8 — prefer Metabase health tier when present; fall back to legacy stoplight.
  const _ht = normalizeHealthTier((customer as any).metabase_health?.health_tier);
  const stoplightColor = _ht
    ? HEALTH_TIER_COLORS[_ht]
    : (s.stoplight === "RED" ? "#ef4444" : s.stoplight === "YELLOW" ? "#f59e0b" : "#10b981");
  const stoplightLabel = _ht
    ? HEALTH_TIER_LABELS[_ht]
    : (s.stoplight === "RED"
        ? "Needs attention"
        : s.stoplight === "YELLOW"
          ? "Keep an eye on"
          : "Doing fine");

  const lastTouch =
    customer.metrics.last_any_iso === null
      ? "never"
      : `${daysSinceIso(customer.metrics.last_any_iso)}d ago`;
  const commsLine = `Last touch: ${lastTouch} · ${customer.metrics.total_30d} comms in 30d`;
  const planText = customer.plan_amount > 0 ? `$${customer.plan_amount.toFixed(0)}/mo` : "";
  const amText = customer.am_name || "Unassigned";

  const trajectoryArrow = (() => {
    switch (s.trajectory_7d) {
      case "improving":
        return { glyph: "↓", color: "#059669", title: "Improving vs. 7 days ago" };
      case "worsening":
        return { glyph: "↑", color: "#dc2626", title: "Worsening vs. 7 days ago" };
      case "stable":
        return { glyph: "—", color: "#6b7280", title: "Stable vs. 7 days ago" };
      default:
        return { glyph: "", color: "#6b7280", title: "" };
    }
  })();

  // Top 3 active signals
  const activeSignals = collectActiveSignals(customer).slice(0, 3);

  const chipBaseClass =
    "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ring-1";
  const chipClassForTone = (tone: "rose" | "amber") =>
    tone === "rose"
      ? `${chipBaseClass} bg-zoca-pink/12 text-zoca-pink-bright ring-zoca-pink/25`
      : `${chipBaseClass} bg-amber-500/12 text-amber-700 ring-amber-500/25`;

  const narrative = s.reason_one_line && s.reason_one_line.trim() !== ""
    ? s.reason_one_line
    : s.stoplight === "GREEN"
      ? "All systems healthy — keep doing what you're doing."
      : s.stoplight === "YELLOW"
        ? "Watch this one — signal mix is mixed."
        : "";

  const placementTransform =
    pos.placement === "above" ? "translateY(-100%)" : "translateY(0)";

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`Preview for ${customer.company || customer.entity_id.slice(0, 8)}`}
      data-v2-hover-preview="1"
      onMouseEnter={() => {
        /* keep preview alive while hovering it */
      }}
      onMouseLeave={() => onClose()}
      style={{
        position: "absolute",
        top: pos.top,
        left: pos.left,
        width: POPOVER_WIDTH,
        background: "var(--zoca-bg-soft)",
        border: "0.5px solid var(--zoca-border)",
        borderRadius: "var(--zoca-radius-lg, 14px)",
        boxShadow: "0 8px 24px rgba(11,5,29,0.10)",
        zIndex: 9000,
        transform: placementTransform,
      }}
      className="rounded-zoca-lg p-4"
    >
      {/* Header — bizname + stoplight chip */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-zoca-text">
            {customer.company || customer.entity_id.slice(0, 8)}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zoca-text-2">
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 7,
                height: 7,
                borderRadius: "50%",
                backgroundColor: stoplightColor,
                boxShadow: `0 0 6px ${stoplightColor}`,
              }}
            />
            <span>{stoplightLabel}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-right">
          <span
            className="text-[18px] font-bold tabular-nums text-zoca-text"
            title="Composite risk score"
          >
            {s.composite}
          </span>
          {trajectoryArrow.glyph && (
            <span
              className="text-[12px] font-semibold"
              style={{ color: trajectoryArrow.color }}
              title={trajectoryArrow.title}
              aria-label={trajectoryArrow.title}
            >
              {trajectoryArrow.glyph}
            </span>
          )}
        </div>
      </div>

      {/* Narrative */}
      {narrative && (
        <p className="mt-2 text-[12px] leading-snug text-zoca-text">{narrative}</p>
      )}

      {/* Top signals */}
      {activeSignals.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {activeSignals.map((sig) => (
            <span
              key={sig.label}
              className={chipClassForTone(s.stoplight === "RED" ? "rose" : "amber")}
              title={sig.label}
            >
              {sig.label}
            </span>
          ))}
        </div>
      )}

      {/* Comms + plan + AM line */}
      <div className="mt-2.5 text-[11px] text-zoca-text-2 tabular-nums">{commsLine}</div>
      <div className="mt-0.5 text-[11px] text-zoca-text-2">
        {amText}
        {planText && <> · {planText}</>}
      </div>

      {/* Keyboard hint */}
      <div className="mt-3 border-t border-zoca-border pt-2 text-[10px] text-zoca-text-3">
        Press <kbd className="rounded border border-zoca-border bg-zoca-bg-soft px-1 font-mono text-[10px]">→</kbd> to open detail
      </div>
    </div>,
    document.body,
  );
}

function daysSinceIso(iso: string | null): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400_000));
}

type ActiveSignal = { key: string; label: string };

function collectActiveSignals(c: ScoredCustomerV2): ActiveSignal[] {
  const s = c.signals_v2;
  const out: ActiveSignal[] = [];
  if ((s.sig_client_silent ?? 0) >= 65) out.push({ key: "client_silent", label: "Client silent" });
  if ((s.sig_we_silent ?? 0) >= 65) out.push({ key: "we_silent", label: "We silent" });
  if ((s.sig_response_drop ?? 0) >= 65) out.push({ key: "resp_drop", label: "Resp drop" });
  if ((s.sig_volume_collapse ?? 0) >= 55) out.push({ key: "vol_collapse", label: "Vol collapse" });
  if ((s.sig_usage ?? 0) >= 55) out.push({ key: "usage_low", label: "Usage low" });
  if ((s.sig_billing ?? 0) >= 40) out.push({ key: "billing", label: "Billing" });
  if (s.flag_performance) out.push({ key: "perf_flag", label: "Perf flag" });
  if (s.flag_tickets) out.push({ key: "tickets", label: "Tickets" });
  return out;
}
