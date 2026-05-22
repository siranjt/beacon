"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (2 hex/rgba + 0 tailwind-rose swept)

import * as React from "react";

/**
 * Phase 32 — EmptyStateNoActions.
 *
 * Hand-drawn-feel SVG: a clipboard with empty content lines. Pink clip,
 * blue paper lines. 1.5px strokes. ~120x120px.
 */
export default function EmptyStateNoActions() {
  return (
    <svg
      width="120"
      height="120"
      viewBox="0 0 120 120"
      role="img"
      aria-label="No actions yet illustration"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
    >
      {/* Clipboard board — slightly imperfect curves */}
      <path
        d="M 32 28 L 88 28 C 90 28, 91 30, 91 32 L 91 96 C 91 98, 89 100, 87 100 L 33 100 C 31 100, 29 98, 29 96 L 29 31 C 29 29, 30 28, 32 28 Z"
        stroke="#146ef5"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Clip at top */}
      <path
        d="M 50 22 L 70 22 C 72 22, 73 23, 73 25 L 73 34 C 73 36, 72 37, 70 37 L 50 37 C 48 37, 47 36, 47 34 L 47 25 C 47 23, 48 22, 50 22 Z"
        stroke="#C8431D"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Empty lines (a few dashed-like rows) */}
      <g stroke="#146ef5" strokeWidth="1.5" strokeLinecap="round" opacity="0.45">
        <path d="M 39 52 L 79 52" />
        <path d="M 39 64 L 70 64" />
        <path d="M 39 76 L 75 76" />
        <path d="M 39 88 L 64 88" />
      </g>
      {/* Subtle pink dot — sparkle */}
      <circle cx="80" cy="46" r="1.6" fill="#C8431D" opacity="0.65" />
    </svg>
  );
}
