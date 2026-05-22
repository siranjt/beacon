"use client";

import * as React from "react";

type Props = {
  /** ISO timestamp the dashboard data was generated at. */
  generatedAt: string | null | undefined;
};

/**
 * Phase 32 — V2FreshnessPulse.
 *
 * A small 6px pulsing dot indicating dashboard freshness.
 *   <= 6h  → emerald, slow pulse
 *   <= 24h → amber,   slow pulse
 *   > 24h  → rose,    fast pulse
 *
 * The keyframes (`v2-freshness-pulse-{green|amber|rose}`) are defined in
 * globals.css. `prefers-reduced-motion: reduce` falls back to a static dot.
 */
export default function V2FreshnessPulse({ generatedAt }: Props) {
  const ageMs = React.useMemo(() => {
    if (!generatedAt) return null;
    const t = Date.parse(generatedAt);
    if (!Number.isFinite(t)) return null;
    return Date.now() - t;
  }, [generatedAt]);

  const variant = pickVariant(ageMs);
  const label = describeAge(ageMs);

  return (
    <span
      role="img"
      aria-label={`Data freshness: ${label}`}
      title={`Last refresh ${label}`}
      className={`v2-freshness-pulse v2-freshness-pulse-${variant}`}
    />
  );
}

function pickVariant(ageMs: number | null): "green" | "amber" | "rose" {
  if (ageMs === null) return "amber";
  const hours = ageMs / 3_600_000;
  if (hours > 24) return "rose";
  if (hours > 6) return "amber";
  return "green";
}

function describeAge(ageMs: number | null): string {
  if (ageMs === null) return "unknown";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
