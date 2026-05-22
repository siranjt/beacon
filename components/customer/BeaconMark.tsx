/**
 * BeaconMark — the four-tier stepped tower with a two-tone flame.
 *
 * Geometry (source-unit coordinates, viewBox -6 -32 12 32):
 *   Tier 1 (base):   12w × 4h   at y = -4
 *   Tier 2:          10w × 4h   at y = -10  (2-unit gap)
 *   Tier 3:           8w × 4h   at y = -16
 *   Tier 4 (top):     6w × 4h   at y = -22
 *   Flame outer:     teardrop   y = -32 to -21
 *   Flame inner:     teardrop   y = -27 to -19
 *
 * Aspect ratio: 3:8 (width:height). At size=20 → width=7.5.
 *
 * Defaults match the Zoca-dashboard palette:
 *   tower:        --zoca-text  (#0b051d)
 *   flame outer:  red          (#dc2626 — fire)
 *   flame inner:  warm yellow  (#facc15 — fire glow)
 *
 * Pass flicker={true} to enable the subtle scale-pulse animation.
 * Defined in app/globals.css as @keyframes beacon-flicker and
 * @keyframes beacon-flicker-inner (1.8s + 1.4s, so the flame never
 * looks like a single rigid shape).
 *
 * Phase 33.brand-PR1
 */

import React, { useEffect, useState } from "react";

interface BeaconMarkProps {
  /** Pixel height. Width is computed at 3:8 ratio. Default: 32 */
  size?: number;
  /** Override tower color. Default: --zoca-text (#0b051d) */
  towerFill?: string;
  /** Override outer flame color. Default: #dc2626 (red) */
  flameOuter?: string;
  /** Override inner flame color. Default: #facc15 (yellow) */
  flameInner?: string;
  /** Enable the subtle flame-flicker animation. Off by default. */
  flicker?: boolean;
  className?: string;
}

export function BeaconMark({
  size = 32,
  towerFill = "#0b051d",
  flameOuter = "#dc2626",
  flameInner = "#facc15",
  flicker = false,
  className,
}: BeaconMarkProps) {
  // Phase 33.brand-watchfire-PR7-38 — listen for cross-component flare events
  // (e.g. customer "Open detail" click) and pulse for 350ms.
  const [flaring, setFlaring] = useState(false);
  useEffect(() => {
    function onFlare() {
      setFlaring(true);
      window.setTimeout(() => setFlaring(false), 360);
    }
    window.addEventListener("beacon:mark-flare", onFlare);
    return () => window.removeEventListener("beacon:mark-flare", onFlare);
  }, []);
  const width = Math.round((size * 12) / 32 * 100) / 100;
  return (
    <svg
      width={width}
      height={size}
      viewBox="-6 -32 12 32"
      className={`${className ?? ""}${flaring ? " beacon-mark-flare" : ""}`.trim() || undefined}
      role="img"
      aria-label="Beacon"
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect x="-6" y="-4"  width="12" height="4" fill={towerFill} />
      <rect x="-5" y="-10" width="10" height="4" fill={towerFill} />
      <rect x="-4" y="-16" width="8"  height="4" fill={towerFill} />
      <rect x="-3" y="-22" width="6"  height="4" fill={towerFill} />
      {/* Phase 33.brand-watchfire-T4-flame — 4 nested teardrops with co-prime
          durations (2.2 / 1.7 / 1.3 / 0.9s) per spec §11 row 19. The flame
          layers never re-sync so the mark always feels alive. CSS keyframes
          beacon-flame-1..4 live in globals.css; reduced-motion guard there. */}
      <path
        d="M 0 -32 C 4 -28 5 -23 3 -21 L -3 -21 C -5 -23 -4 -28 0 -32 Z"
        fill={flameOuter}
        className={flicker ? "beacon-flame-1" : undefined}
        style={{ transformOrigin: "0px -21px" }}
      />
      <path
        d="M 0 -30 C 3.4 -27 4 -23 2.5 -21 L -2.5 -21 C -4 -23 -3.4 -27 0 -30 Z"
        fill={flameOuter}
        opacity="0.75"
        className={flicker ? "beacon-flame-2" : undefined}
        style={{ transformOrigin: "0px -21px" }}
      />
      <path
        d="M 0 -27 C 2 -24 3 -21 2 -19 L -2 -19 C -3 -21 -2 -24 0 -27 Z"
        fill={flameInner}
        className={flicker ? "beacon-flame-3" : undefined}
        style={{ transformOrigin: "0px -19px" }}
      />
      <path
        d="M 0 -25 C 1.2 -23 1.5 -21 1 -19 L -1 -19 C -1.5 -21 -1.2 -23 0 -25 Z"
        fill={flameInner}
        className={flicker ? "beacon-flame-4" : undefined}
        style={{ transformOrigin: "0px -19px" }}
      />
    </svg>
  );
}
