/**
 * KeeperChip — the canonical inline trust marker for Keeper-sourced facts.
 *
 * Wraps any value that came from Keeper — a Beam cite chip, a panel header,
 * a suggested action card. Renders as a small pill: [vault] K · topic, with
 * the pill background tinted by confidence tier (brass=high, ember=moderate,
 * patina=low). The vault glyph itself stays brass+ember at every confidence
 * level so the brand mark is instantly recognizable.
 *
 * Three sizes:
 *   - inline (default): 11px text, 11px glyph — sits inside prose
 *   - md: 13px text, 14px glyph — for badge use on cards
 *   - lg: 14px text, 18px glyph — for panel headers + admin pages
 *
 * Label format is controlled by lib/keeper/chip-config.ts → formatKeeperChipLabel.
 * Direction C + abbrev format locked in 2026-06-12.
 */

import KeeperVault from "./KeeperVault";
import {
  formatKeeperChipLabel,
  type KeeperChipLabelFormat,
} from "@/lib/keeper/chip-config";

export type KeeperChipConfidence = "high" | "moderate" | "low" | "unverified";
export type KeeperChipSize = "inline" | "md" | "lg";

interface Props {
  /** The Keeper topic / subcategory / field this fact came from. */
  topic: string;
  /** Optional source label — only renders in "provenance" label-format mode. */
  source?: string;
  /** Optional confirmation date — only renders in "provenance" mode. */
  confirmedAt?: string | null;
  /**
   * Confidence tier. Controls the pill background tint. Default "high".
   * "unverified" is used by Beam when it can't resolve a citation key — sits
   * in muted gray so QA can spot hallucinations.
   */
  confidence?: KeeperChipConfidence;
  size?: KeeperChipSize;
  /** Optional click handler — typically opens an X-Ray panel. */
  onClick?: () => void;
  /** Override the rendered label format for this chip only (rarely needed). */
  formatOverride?: KeeperChipLabelFormat;
}

const PALETTE: Record<
  KeeperChipConfidence,
  { bg: string; text: string; border: string }
> = {
  high: {
    // Brass — full confidence
    bg: "rgba(217, 164, 65, 0.14)",
    text: "#8a6014",
    border: "rgba(217, 164, 65, 0.4)",
  },
  moderate: {
    // Ember — moderate confidence
    bg: "rgba(200, 67, 29, 0.10)",
    text: "#8b3416",
    border: "rgba(200, 67, 29, 0.35)",
  },
  low: {
    // Patina — low confidence, but still grounded in Keeper
    bg: "rgba(74, 124, 89, 0.10)",
    text: "#2f5036",
    border: "rgba(74, 124, 89, 0.35)",
  },
  unverified: {
    // Gray — citation key didn't resolve. Tells the QA reader something is off.
    bg: "rgba(120, 120, 120, 0.10)",
    text: "#666",
    border: "rgba(120, 120, 120, 0.35)",
  },
};

const SIZE_STYLES: Record<
  KeeperChipSize,
  { font: number; pad: string; gap: number; glyph: number }
> = {
  inline: { font: 11, pad: "3px 8px", gap: 5, glyph: 11 },
  md: { font: 13, pad: "4px 10px", gap: 6, glyph: 14 },
  lg: { font: 14, pad: "5px 12px", gap: 7, glyph: 18 },
};

export default function KeeperChip({
  topic,
  source,
  confirmedAt,
  confidence = "high",
  size = "inline",
  onClick,
  formatOverride,
}: Props) {
  const pal = PALETTE[confidence];
  const sz = SIZE_STYLES[size];
  // Allow per-chip override (rare), otherwise use the global config.
  const label =
    formatOverride === undefined
      ? formatKeeperChipLabel({ topic, source, confirmedAt })
      : formatLabelOverride({ topic, source, confirmedAt }, formatOverride);

  const interactive = typeof onClick === "function";

  return (
    <span
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: sz.gap,
        fontSize: sz.font,
        lineHeight: 1,
        padding: sz.pad,
        borderRadius: 999,
        background: pal.bg,
        color: pal.text,
        border: `0.5px solid ${pal.border}`,
        fontFamily: "-apple-system, Inter, system-ui, sans-serif",
        fontWeight: 500,
        cursor: interactive ? "pointer" : "default",
        verticalAlign: "1px",
      }}
      title={`From Keeper · ${topic}${source ? ` · ${source}` : ""}`}
    >
      <KeeperVault size={sz.glyph} />
      <span>{label}</span>
    </span>
  );
}

/**
 * Per-chip format override helper. Mirrors lib/keeper/chip-config.ts's
 * `formatKeeperChipLabel` but lets a single chip render in a different format
 * (e.g. one specific surface insists on the full Keeper word). Rarely needed.
 */
function formatLabelOverride(
  args: { topic: string; source?: string; confirmedAt?: string | null },
  format: KeeperChipLabelFormat,
): string {
  const { topic, source, confirmedAt } = args;
  switch (format) {
    case "topic_only":
      return topic;
    case "full":
      return `Keeper · ${topic}`;
    case "provenance": {
      const parts = [topic];
      if (source) parts.push(source);
      if (confirmedAt) parts.push(confirmedAt);
      return parts.join(" · ");
    }
    case "abbrev":
    default:
      return `K · ${topic}`;
  }
}
