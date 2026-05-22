"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (3 hex/rgba + 0 tailwind-rose swept)

import * as React from "react";

/**
 * Phase 32 — EmptyStateNoTickets.
 *
 * Hand-drawn-feel SVG: a single ticket with a soft notch on each side and
 * a clean inner area, accented by a check + sparkle to signal "all clear".
 * Pink ticket outline, blue check. 1.5px strokes. ~120x120px.
 */
export default function EmptyStateNoTickets() {
  return (
    <svg
      width="120"
      height="120"
      viewBox="0 0 120 120"
      role="img"
      aria-label="No tickets illustration"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
    >
      {/* Ticket outline with side notches */}
      <path
        d="M 24 40
           C 24 38, 26 36, 28 36
           L 92 36
           C 94 36, 96 38, 96 40
           L 96 52
           C 92 52, 89 55, 89 60
           C 89 65, 92 68, 96 68
           L 96 80
           C 96 82, 94 84, 92 84
           L 28 84
           C 26 84, 24 82, 24 80
           L 24 68
           C 28 68, 31 65, 31 60
           C 31 55, 28 52, 24 52
           Z"
        stroke="#C8431D"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Perforated divider down the middle (small dashes) */}
      <g stroke="#C8431D" strokeWidth="1.4" strokeLinecap="round" opacity="0.45">
        <path d="M 60 44 L 60 47" />
        <path d="M 60 50 L 60 53" />
        <path d="M 60 67 L 60 70" />
        <path d="M 60 73 L 60 76" />
      </g>
      {/* Checkmark on the right half — signals "clean slate" */}
      <path
        d="M 68 62 L 74 68 L 84 56"
        stroke="#146ef5"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Sparkle near upper right */}
      <g stroke="#C8431D" strokeWidth="1.4" strokeLinecap="round">
        <path d="M 102 26 L 102 32" />
        <path d="M 99 29 L 105 29" />
      </g>
      {/* Sparkle dot near bottom left */}
      <circle cx="20" cy="96" r="1.6" fill="#146ef5" opacity="0.65" />
    </svg>
  );
}
