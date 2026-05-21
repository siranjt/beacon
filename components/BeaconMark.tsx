/**
 * BeaconMark — 4-tier stepped tower with a 4-layer blazing flame.
 *
 * Pass `flicker={true}` to enable the co-prime (0.9/1.3/1.7/2.2s) flame animation.
 * Aspect ratio: 3:8 (width:height). At size=20 → width=7.5.
 *
 * Originally built for Customer Beacon's nav lockup. Reused unchanged here as the
 * umbrella shell's brand identity.
 */

"use client";

import React, { useEffect, useState } from "react";

interface BeaconMarkProps {
  /** Pixel height. Width is computed at 3:8 ratio. Default: 32 */
  size?: number;
  /** Override tower color. Default: Char #2B1F14 */
  towerFill?: string;
  /** Override outer flame color. Default: Ember #C8431D */
  flameOuter?: string;
  /** Override inner flame color. Default: Gold #FBBF24 */
  flameInner?: string;
  /** Enable the subtle flame-flicker animation. Off by default. */
  flicker?: boolean;
  className?: string;
}

export function BeaconMark({
  size = 32,
  towerFill = "#2B1F14",
  flameOuter = "#C8431D",
  flameInner = "#FBBF24",
  flicker = false,
  className,
}: BeaconMarkProps) {
  // Cross-component "flare" event — used during navigation (e.g. clicking
  // into an agent triggers a brief halo pulse on the nav mark).
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
      {/* 4 nested teardrops, co-prime animation durations */}
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

export default BeaconMark;
