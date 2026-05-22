"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (4 hex/rgba + 0 tailwind-rose swept)

// Phase 33.D — KPI tiles with proper filter wiring.
//
// Previously: every tile rendered `<a href={tile.href || "#"}>` and the
// "selected" prop was just a visual hint (no actual filter). Need to call /
// Watch / Healthy all looked clickable but only Need-to-call had a pink
// outline — Watch & Healthy did nothing on click.
//
// Phase 33.D:
//   - `onClick` is now a first-class prop. If set, clicking the tile fires
//     the handler instead of navigating. Existing `href` still works as a
//     fallback for tiles that are just deep-links.
//   - The `selected` pink-outline treatment is independent of which tile it
//     decorates — wire it to your filter state and it'll Just Work.

import { AnimatedNumber } from "./AnimatedNumber";
import { useTilt } from "@/lib/customer/hooks/useTilt";

type Tile = {
  label: string;
  value: number | string;
  subtitle: string;
  color: "midnight" | "pink" | "amber" | "green" | "crimson";
  href?: string;
  /** Phase 33.D — fires on click. If set, prevents default <a> navigation. */
  onClick?: () => void;
  selected?: boolean;
};

type Props = {
  tiles: Tile[];
};

// Phase 33.brand-watchfire-audit-T2 — KPI tile semantic colors → Watchfire.
const COLORS: Record<Tile["color"], string> = {
  midnight: "var(--zoca-text)", // Char
  pink: "var(--zoca-pink)",     // Ember
  amber: "#5C4317",             // Dark Brass-Brown (was #b45309)
  green: "#2D4843",             // Pine (was #047857)
  crimson: "#7C2D12",           // Deep Crimson (was #dc2626)
};

// Selected-state palette — kept per color so each tile glows in its own hue.
const SELECTED_OUTLINE: Record<Tile["color"], { border: string; shadow: string; gradient: string; labelColor: string }> = {
  midnight: {
    border: "var(--zoca-text)",
    shadow: "0 0 0 1px rgba(11,5,29,0.25), 0 0 24px rgba(11,5,29,0.18)",
    gradient: "linear-gradient(180deg, rgba(11,5,29,0.04), rgba(11,5,29,0.06)), var(--zoca-bg-soft)",
    labelColor: "var(--zoca-text)",
  },
  pink: {
    border: "var(--zoca-pink)",
    shadow: "0 0 0 1px rgba(200, 67, 29, 0.35), 0 0 24px rgba(252, 228, 214, 0.35)",
    gradient: "linear-gradient(180deg, rgba(200, 67, 29, 0.04), rgba(252, 228, 214, 0.06)), var(--zoca-bg-soft)",
    // Phase 33.brand-watchfire-audit-T2 — Deep Ember replaces V2 fuchsia.
    labelColor: "#7C2D12",
  },
  // Phase 33.brand-watchfire-audit-T2 — amber → Brass family.
  amber: {
    border: "#D9A441",
    shadow: "0 0 0 1px rgba(217, 164, 65, 0.35), 0 0 24px rgba(245, 230, 187, 0.45)",
    gradient: "linear-gradient(180deg, rgba(217, 164, 65, 0.04), rgba(245, 230, 187, 0.10)), var(--zoca-bg-soft)",
    labelColor: "#5C4317",
  },
  // Phase 33.brand-watchfire-audit-T2 — green → Patina family.
  green: {
    border: "#4A7C59",
    shadow: "0 0 0 1px rgba(74, 124, 89, 0.35), 0 0 24px rgba(218, 229, 220, 0.45)",
    gradient: "linear-gradient(180deg, rgba(74, 124, 89, 0.04), rgba(218, 229, 220, 0.10)), var(--zoca-bg-soft)",
    labelColor: "#2D4843",
  },
  // Phase 33.brand-watchfire-audit-T2 — crimson → Deep Crimson family.
  crimson: {
    border: "#7C2D12",
    shadow: "0 0 0 1px rgba(124, 45, 18, 0.40), 0 0 24px rgba(245, 201, 182, 0.45)",
    gradient: "linear-gradient(180deg, rgba(124, 45, 18, 0.04), rgba(245, 201, 182, 0.10)), var(--zoca-bg-soft)",
    labelColor: "#7C2D12",
  },
};

export function V2KpiTiles({ tiles }: Props) {
  return (
    <div
      // Phase 33.brand-watchfire-PR6-final — stagger fade-up per spec §11 row 7.
      className="mx-6 mb-6 grid gap-2.5 beacon-kpi-staggered"
      style={{ gridTemplateColumns: `repeat(${tiles.length}, 1fr)` }}
    >
      {tiles.map((tile, i) => (
        <KpiTile key={i} tile={tile} index={i} />
      ))}
    </div>
  );
}

function KpiTile({ tile, index }: { tile: Tile; index: number }) {
  const isSelected = !!tile.selected;
  const sel = isSelected ? SELECTED_OUTLINE[tile.color] : null;
  const tiltRef = useTilt<HTMLAnchorElement>();

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (tile.onClick) {
      e.preventDefault();
      tile.onClick();
    }
    // If only `href` is set, let the default navigation happen.
  };

  return (
    <a
      ref={tiltRef}
      href={tile.href || "#"}
      onClick={handleClick}
      role={tile.onClick && !tile.href ? "button" : undefined}
      aria-pressed={tile.onClick ? isSelected : undefined}
      // Phase 33.brand-watchfire-T5 — Light Parchment surface, not white.
      className={`block bg-zoca-bg-soft rounded-2xl px-4 py-4 no-underline transition cursor-pointer${isSelected ? " beacon-kpi-breath" : ""}`}
      style={{
        border: sel ? `1px solid ${sel.border}` : "1px solid var(--zoca-border)",
        boxShadow: sel ? sel.shadow : "0 1px 3px rgba(11,5,29,0.04)",
        background: sel ? sel.gradient : "var(--zoca-bg-soft)",
        transformStyle: "preserve-3d",
        willChange: "transform",
      }}
    >
      <div className="flex items-center justify-between mb-2.5">
        <span
          className="zoca-micro-label"
          style={sel ? { color: sel.labelColor } : undefined}
        >
          {tile.label}
        </span>
        <span
          className="text-[13px] text-zoca-text-3"
          style={sel ? { color: sel.border } : undefined}
        >
          →
        </span>
      </div>
      <div
        className="font-extrabold leading-none"
        style={{
          fontSize: "32px",
          color: COLORS[tile.color],
          letterSpacing: "-0.03em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {typeof tile.value === "number" ? (
          <AnimatedNumber value={tile.value} duration={900} style={{ animationDelay: `${index * 80}ms` }} />
        ) : (
          tile.value
        )}
      </div>
      <div className="text-[11px] text-zoca-text-2 mt-1.5">{tile.subtitle}</div>
    </a>
  );
}

export default V2KpiTiles;
