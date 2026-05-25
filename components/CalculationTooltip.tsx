"use client";

/**
 * CalculationTooltip — Phase E-9.
 *
 * Inline "?" marker that reveals a parchment popover with an explanation
 * of how a metric is calculated. Click or hover to open; click outside or
 * Esc to close.
 *
 * Usage:
 *   <CalculationTooltip
 *     label="Composite score"
 *     body={
 *       <>
 *         Weighted sum of:<br/>
 *         • 50% comms signals (silence, response, volume)<br/>
 *         • 30% product-usage tier<br/>
 *         • 20% billing health<br/>
 *         Lower is healthier. RED ≥ 65, YELLOW 35-64.
 *       </>
 *     }
 *   />
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  label: string;
  body: React.ReactNode;
  /** Marker size in pixels. Default 14. */
  size?: number;
}

export default function CalculationTooltip({ label, body, size = 14 }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onClick = (e: MouseEvent) => {
      if (
        wrapRef.current &&
        e.target instanceof Node &&
        !wrapRef.current.contains(e.target)
      ) {
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open, close]);

  return (
    <span
      ref={wrapRef}
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
    >
      <button
        type="button"
        aria-label={`How ${label} is calculated`}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseEnter={() => setOpen(true)}
        style={{
          appearance: "none",
          padding: 0,
          margin: 0,
          width: size,
          height: size,
          borderRadius: "50%",
          background: "transparent",
          border: "1px solid var(--zoca-text-3)",
          color: "var(--zoca-text-2)",
          cursor: "help",
          fontSize: size * 0.75,
          fontFamily: "-apple-system, Inter, system-ui, sans-serif",
          fontWeight: 500,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1,
        }}
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 50,
            width: 260,
            background: "#F8EFD7",
            border: "1px solid #D4C29B",
            borderRadius: 10,
            padding: "10px 12px",
            boxShadow: "0 12px 28px -8px rgba(43,31,20,0.35)",
            fontFamily: "-apple-system, Inter, system-ui, sans-serif",
            fontSize: 11.5,
            color: "var(--zoca-text)",
            lineHeight: 1.5,
            textAlign: "left",
          }}
        >
          <div
            style={{
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontWeight: 500,
              fontSize: 12.5,
              marginBottom: 6,
              color: "var(--zoca-text)",
            }}
          >
            {label}
          </div>
          <div style={{ color: "var(--zoca-text-2)" }}>{body}</div>
        </span>
      )}
    </span>
  );
}
