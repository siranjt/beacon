"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (3 hex/rgba + 0 tailwind-rose swept)

import * as React from "react";

/**
 * Phase 32 — EmptyStateAllClear.
 *
 * Hand-drawn-feel SVG: a soft circle holding a checkmark, with a sparkle
 * nearby. Pink + blue brand accents on 1.5px strokes. ~120x120px.
 */
export default function EmptyStateAllClear() {
  return (
    <svg
      width="120"
      height="120"
      viewBox="0 0 120 120"
      role="img"
      aria-label="All clear illustration"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
    >
      {/* Soft pink circle backdrop — slightly off-round for hand-drawn feel */}
      <path
        d="M 60 22 C 80 22, 98 38, 98 60 C 98 84, 80 100, 58 100 C 36 100, 22 82, 22 60 C 22 38, 40 22, 60 22 Z"
        stroke="#C8431D"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.85"
      />
      {/* Checkmark */}
      <path
        d="M 42 60 L 54 72 L 78 48"
        stroke="#146ef5"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Sparkle 1 — upper right */}
      <g stroke="#C8431D" strokeWidth="1.5" strokeLinecap="round">
        <path d="M 96 30 L 96 36" />
        <path d="M 92 33 L 100 33" />
      </g>
      {/* Sparkle 2 — small dot lower left */}
      <g stroke="#146ef5" strokeWidth="1.5" strokeLinecap="round">
        <path d="M 24 92 L 24 96" />
        <path d="M 22 94 L 26 94" />
      </g>
      {/* Sparkle 3 — tiny dot upper left */}
      <circle cx="30" cy="34" r="1.4" fill="#C8431D" opacity="0.75" />
    </svg>
  );
}
