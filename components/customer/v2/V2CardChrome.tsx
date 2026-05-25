"use client";

/**
 * V2CardChrome — Phase E-15.4 extraction.
 *
 * Three pin/snooze sub-controls that were inlined in V2CustomerCard.tsx,
 * pushing that file past 1700 lines. They share theme but no state with
 * the parent card; lifting them removes ~150 lines from V2CustomerCard
 * without touching its state machine.
 *
 *   PinButton      — pin/unpin toggle in the card header
 *   SnoozeMenu     — outline button + day-preset popover
 *   SnoozedBanner  — chip that replaces the action area while snoozed
 *
 * Bodies are copied verbatim from V2CustomerCard so visual + a11y +
 * keyboard behavior is unchanged.
 */

import * as React from "react";
import { useEffect, useRef, useState } from "react";

export function PinButton({
  isPinned,
  onToggle,
  popping = false,
}: {
  isPinned: boolean;
  onToggle: () => void;
  /** Phase 22.C — when true, the icon plays the v2-pin-pop keyframe (spring + rotation). */
  popping?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="inline-flex items-center justify-center transition cursor-pointer"
      style={{
        width: "28px",
        height: "28px",
        borderRadius: "8px",
        background: "transparent",
        border: "1px solid var(--zoca-border)",
        color: isPinned ? "var(--zoca-pink)" : "var(--zoca-text-2)",
        boxShadow: isPinned ? "0 0 12px rgba(252, 228, 214, 0.4)" : "none",
        flexShrink: 0,
      }}
      title={isPinned ? "Unpin" : "Pin"}
      aria-label={isPinned ? "Unpin customer" : "Pin customer"}
      aria-pressed={isPinned}
    >
      <i
        className={`ti ti-pin${popping ? " v2-pin-popping" : ""}`}
        style={{ fontSize: "15px", display: "inline-block" }}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Phase 19: SnoozeMenu — outline button that pops a small panel with day
// presets. Self-contained: holds its own open/closed state + outside-click.
// ---------------------------------------------------------------------------
export function SnoozeMenu({
  onPick,
  size = "sm",
}: {
  onPick: (days: number) => void;
  size?: "sm" | "xs";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const fontSize = size === "xs" ? "10.5px" : "11px";
  const padding = size === "xs" ? "4px 10px" : "5px 12px";
  const presets: { label: string; days: number }[] = [
    { label: "1 day", days: 1 },
    { label: "3 days", days: 3 },
    { label: "7 days", days: 7 },
    { label: "14 days", days: 14 },
    { label: "30 days", days: 30 },
  ];
  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="zoca-btn zoca-btn-ghost"
        style={{ fontSize, padding }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Snooze customer"
        title="Hide this customer from your triage view for N days"
      >
        Snooze ▾
      </button>
      {open && (
        <div
          role="menu"
          // Phase 33.brand-watchfire-PR7-39 — brass border draw on snooze dropdown entry.
          className="beacon-dropdown-entry absolute right-0 z-20 mt-1 rounded-zoca border border-zoca-border bg-zoca-bg-soft py-1 shadow-zoca-sm"
          style={{ minWidth: 110 }}
        >
          {presets.map((p) => (
            <button
              key={p.days}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(p.days);
              }}
              className="block w-full px-3 py-1 text-left text-[11.5px] text-zoca-text hover:bg-zoca-bg-soft"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SnoozedBanner({
  snoozedUntil,
  onUnsnooze,
}: {
  snoozedUntil: string;
  onUnsnooze: () => void;
}) {
  const dt = new Date(snoozedUntil);
  const label = isNaN(dt.getTime())
    ? snoozedUntil
    : dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className="rounded-zoca-pill px-2.5 py-1 text-[11px] font-medium"
        style={{
          background: "rgba(245, 158, 11, 0.10)",
          color: "#92400e",
          border: "1px solid rgba(245, 158, 11, 0.30)",
        }}
        aria-live="polite"
      >
        💤 Snoozed until {label}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onUnsnooze();
        }}
        className="zoca-btn zoca-btn-ghost"
        style={{ fontSize: "10.5px", padding: "4px 10px" }}
        aria-label="Unsnooze customer"
      >
        Unsnooze
      </button>
    </div>
  );
}
