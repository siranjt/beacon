"use client";

/**
 * FreshnessIndicator — shows when data was last refreshed. Phase E-9.
 *
 * Renders "3 min ago" with a colored dot + hover tooltip showing absolute
 * timestamp and optional source label. Color codes:
 *   - patina (green)  — fresh, < FRESH_MAX_MIN
 *   - brass (yellow)  — stale-ish, < STALE_MAX_MIN
 *   - ember (red)     — stale, ≥ STALE_MAX_MIN
 *
 * Updates every 30 seconds so the relative label drifts in real time.
 *
 * Usage:
 *   <FreshnessIndicator ts={snapshot.generatedAt} source="Snapshot · hourly cron" />
 */

import { useEffect, useState } from "react";

const FRESH_MAX_MIN = 15;
const STALE_MAX_MIN = 120;
const TICK_MS = 30_000;

interface Props {
  /** ISO timestamp or null/undefined. */
  ts: string | null | undefined;
  /** Optional source label for the tooltip ("Snapshot · hourly cron"). */
  source?: string;
  /** Compact label without the "as of" prefix. Defaults to false. */
  compact?: boolean;
}

function relative(ms: number): string {
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function colorForAge(ms: number): { dot: string; text: string } {
  const minutes = ms / 60_000;
  if (minutes < FRESH_MAX_MIN)
    return { dot: "#4A7C59", text: "var(--zoca-text-2)" }; // Patina
  if (minutes < STALE_MAX_MIN)
    return { dot: "#D9A441", text: "var(--zoca-text-2)" }; // Brass
  return { dot: "#C8431D", text: "#C8431D" }; // Ember (stale = visible)
}

export default function FreshnessIndicator({ ts, source, compact = false }: Props) {
  // Tick state forces re-render every 30s so the "min ago" stays current.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  if (!ts) {
    return (
      <span
        style={{
          fontFamily: "-apple-system, Inter, system-ui, sans-serif",
          fontSize: 11,
          color: "var(--zoca-text-3)",
        }}
      >
        {compact ? "—" : "freshness unknown"}
      </span>
    );
  }

  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) {
    return (
      <span
        style={{
          fontFamily: "-apple-system, Inter, system-ui, sans-serif",
          fontSize: 11,
          color: "var(--zoca-text-3)",
        }}
      >
        {compact ? "—" : "freshness unknown"}
      </span>
    );
  }

  const age = Date.now() - parsed;
  const c = colorForAge(age);
  const tooltipDate = new Date(parsed).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const tooltip = source
    ? `${tooltipDate} · ${source}`
    : tooltipDate;

  return (
    <span
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: "-apple-system, Inter, system-ui, sans-serif",
        fontSize: 11,
        color: c.text,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: c.dot,
        }}
      />
      <span>
        {compact ? null : "as of "}
        {relative(age)}
      </span>
    </span>
  );
}
