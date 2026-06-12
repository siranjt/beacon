/**
 * Keeper chip label format — single config switch.
 *
 * 2026-06-12: locked to "abbrev" (`K · topic`) per the Wave A design pick.
 * The vault glyph carries the brand recognition; the "K" prefix accelerates
 * the AM mental model in the first 3 months of rollout. Plan to graduate to
 * "topic_only" in ~Q3 once the pattern is taught and the prefix reads as
 * redundant.
 *
 * To flip: change the export below. No migration, no sweep — every
 * KeeperChip consumes this config at render time.
 */

export type KeeperChipLabelFormat =
  | "topic_only" // "policy"
  | "abbrev" // "K · policy"     ← current
  | "full" // "Keeper · policy"
  | "provenance"; // "policy · BaseSheet · May 8"

export const KEEPER_CHIP_LABEL_FORMAT: KeeperChipLabelFormat = "abbrev";

/**
 * Render a Keeper provenance label per the configured format.
 *
 * `topic` is the Keeper subcategory or named field (e.g. "policy", "owner_email").
 * `source` and `confirmedAt` only render in "provenance" mode.
 */
export function formatKeeperChipLabel(args: {
  topic: string;
  source?: string;
  confirmedAt?: string | null;
}): string {
  const { topic, source, confirmedAt } = args;
  switch (KEEPER_CHIP_LABEL_FORMAT) {
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
