"use client";

/**
 * ConfidenceBadge — small "NN% confident · N signals" pill rendered next
 * to a Beam recommendation or above an ActionCard.
 * Phase E-17 Wave 3a, Feature 2.
 *
 * Beam emits `<confidence: NN% — reason1 / reason2>` inline near any
 * non-trivial proposal. AskPanel parses the marker, strips it from the
 * visible prose, and renders this badge instead. The badge's tooltip /
 * popover shows the full reason list when expanded.
 *
 * Color hint maps to the percent — high confidence reads patina (the
 * watchfire "Good" green), middle reads brass, low reads ember. Never
 * shouts; this is a quiet trust signal, not a banner.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const SANS = "-apple-system, Inter, system-ui, sans-serif";
const SERIF = 'Georgia, "Times New Roman", serif';

const C = {
  text: "var(--zoca-text)",
  text2: "var(--zoca-text-2)",
  text3: "var(--zoca-text-3)",
  surface: "#F8EFD7",
  parchment: "#F0E4CC",
  border: "#D4C29B",
  ember: "#C8431D",
  brass: "#D9A441",
  patina: "#4A7C59",
  char: "#2B1F14",
};

export interface ConfidenceData {
  percent: number;
  reasons: string[];
  /** Raw marker as emitted by the model — kept for tooltip / debug. */
  raw: string;
}

interface Props {
  data: ConfidenceData;
  /**
   * "inline" — small chip suitable for embedding next to prose.
   * "card" — slightly larger pill suitable for the top of an ActionCard.
   */
  variant?: "inline" | "card";
}

function tierFor(pct: number): {
  border: string;
  fg: string;
  bg: string;
  label: string;
} {
  if (pct >= 80) {
    return {
      border: C.patina,
      fg: C.patina,
      bg: "rgba(74, 124, 89, 0.10)",
      label: "high",
    };
  }
  if (pct >= 55) {
    return {
      border: C.brass,
      fg: C.char,
      bg: "rgba(217, 164, 65, 0.16)",
      label: "medium",
    };
  }
  return {
    border: C.ember,
    fg: C.ember,
    bg: "rgba(200, 67, 29, 0.08)",
    label: "low",
  };
}

export default function ConfidenceBadge({ data, variant = "inline" }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onToggle = useCallback(() => setOpen((v) => !v), []);

  const tier = tierFor(data.percent);
  const isCard = variant === "card";
  const reasonsCount = data.reasons.length;
  const summary = `${data.percent}% confident · ${reasonsCount} signal${reasonsCount === 1 ? "" : "s"}`;

  return (
    <span
      ref={wrapRef}
      style={{
        position: "relative",
        display: "inline-block",
        // The default `pre-wrap` rule on assistant bubbles preserves the
        // surrounding newlines; we just want the badge to act as one token.
        verticalAlign: "baseline",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={`Beam confidence: ${data.percent}% — click to see reasoning`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: isCard ? "3px 10px" : "2px 8px",
          fontSize: isCard ? 11 : 10,
          fontWeight: 600,
          fontFamily: SANS,
          color: tier.fg,
          background: tier.bg,
          border: `1px solid ${tier.border}`,
          borderRadius: 999,
          cursor: "pointer",
          lineHeight: 1.3,
          whiteSpace: "nowrap",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: tier.border,
            flexShrink: 0,
          }}
        />
        {summary}
      </button>

      {open && (
        <span
          role="dialog"
          aria-label="Confidence reasoning"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            minWidth: 240,
            maxWidth: 340,
            padding: "8px 10px",
            background: C.parchment,
            border: `1px solid ${C.border}`,
            borderLeft: `3px solid ${tier.border}`,
            borderRadius: 8,
            boxShadow: "0 8px 24px -8px rgba(43, 31, 20, 0.35)",
            zIndex: 200,
            fontFamily: SANS,
            whiteSpace: "normal",
            textAlign: "left",
          }}
        >
          <span
            style={{
              display: "block",
              fontSize: 9,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: C.text3,
              fontFamily: "ui-monospace, monospace",
              marginBottom: 2,
            }}
          >
            Confidence · {tier.label}
          </span>
          <span
            style={{
              display: "block",
              fontSize: 14,
              fontFamily: SERIF,
              color: C.char,
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            {data.percent}%
          </span>
          {reasonsCount > 0 ? (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {data.reasons.map((r, i) => (
                <li
                  key={i}
                  style={{
                    fontSize: 12,
                    lineHeight: 1.45,
                    color: C.text2,
                    paddingLeft: 12,
                    position: "relative",
                    wordBreak: "break-word",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 6,
                      width: 4,
                      height: 4,
                      borderRadius: "50%",
                      background: tier.border,
                    }}
                  />
                  {r}
                </li>
              ))}
            </ul>
          ) : (
            <span style={{ fontSize: 12, color: C.text3, fontStyle: "italic" }}>
              No reasons provided.
            </span>
          )}
        </span>
      )}
    </span>
  );
}
