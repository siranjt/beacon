/**
 * KeeperVault — the canonical Keeper brand glyph.
 *
 * A small SVG vault / safe with a brass body, an ember combination dial, and
 * four brass tick marks. Replaces "🧠" emoji and avoids any overlap with the
 * BeaconMark flame (which means "Beacon" the platform). Scales from 11px
 * inline → 24px admin without losing form.
 *
 * The glyph itself stays brass+ember at every size — confidence variants live
 * on the surrounding pill background, not on the glyph. That keeps the brand
 * mark instantly recognizable regardless of confidence level.
 *
 * Direction C in the 2026-06-12 Keeper chip design pick.
 */

interface Props {
  /** Pixel size (square). Default 12 for inline use. */
  size?: number;
  /** Optional class for absolute positioning or external animations. */
  className?: string;
  /** Decorative — set to false only if the glyph is the only label. */
  ariaHidden?: boolean;
  /**
   * Color override. By default the brass body uses currentColor's brass
   * sibling token, but when the glyph sits on a tinted pill we render at the
   * pill text color for visual harmony — see KeeperChip variants.
   */
  bodyColor?: string;
  dialColor?: string;
}

export default function KeeperVault({
  size = 12,
  className,
  ariaHidden = true,
  bodyColor,
  dialColor,
}: Props) {
  // Default palette — Watchfire brass + ember.
  const body = bodyColor ?? "#D9A441";
  const dial = dialColor ?? "#C8431D";
  // Stroke widths scale with size so the glyph stays crisp at 11px and at 24px.
  const baseStroke = size >= 18 ? 1.5 : size >= 14 ? 1.6 : 1.8;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      className={className}
      aria-hidden={ariaHidden ? "true" : undefined}
      role={ariaHidden ? undefined : "img"}
      style={{ flexShrink: 0, display: "inline-block", verticalAlign: "-2px" }}
    >
      {/* Vault body */}
      <rect
        x="2"
        y="3"
        width="16"
        height="14"
        rx="2"
        stroke={body}
        strokeWidth={baseStroke}
      />
      {/* Combination dial */}
      <circle
        cx="10"
        cy="10"
        r="3.5"
        stroke={dial}
        strokeWidth={baseStroke}
      />
      {/* Dial center */}
      <circle cx="10" cy="10" r="0.9" fill={dial} />
      {/* Tick marks (top, bottom, left, right of the dial) */}
      <line x1="10" y1="6.5" x2="10" y2="5" stroke={body} strokeWidth={baseStroke} strokeLinecap="round" />
      <line x1="10" y1="15" x2="10" y2="13.5" stroke={body} strokeWidth={baseStroke} strokeLinecap="round" />
      <line x1="6.5" y1="10" x2="5" y2="10" stroke={body} strokeWidth={baseStroke} strokeLinecap="round" />
      <line x1="15" y1="10" x2="13.5" y2="10" stroke={body} strokeWidth={baseStroke} strokeLinecap="round" />
    </svg>
  );
}
