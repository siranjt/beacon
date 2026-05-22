"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (2 hex/rgba + 0 tailwind-rose swept)

import * as React from "react";

type Variant = "all-clear" | "filter-empty" | "snoozed-none" | "pinned-none";

type Props = {
  variant?: Variant;
  title: string;
  subtitle?: string;
};

/**
 * Phase 22.A — animated empty-state. Renders a bouncing circle with a
 * stroked checkmark that draws in over 1s. Used in V2AMTriage when the
 * current filter has zero matching customers (caught up / nothing pinned
 * / nothing snoozed / etc.).
 */
export function EmptyState({ variant = "filter-empty", title, subtitle }: Props) {
  // Phase 33.brand-watchfire-PR10 — idle treatment for genuine all-clear states.
  if (variant === "all-clear") {
    return <BeaconIdleState title={title} subtitle={subtitle} />;
  }
  // Phase 33.brand-watchfire-PR10 — all-clear branch is handled by BeaconIdleState above,
  // so the remaining variants (filter-empty / snoozed-none / pinned-none) all use Ember.
  const accent = "#C8431D";
  const bg = "rgba(200, 67, 29, 0.10)";
  return (
    <div
      className="zoca-fade-in"
      style={{ textAlign: "center", padding: "48px 24px" }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: bg,
          marginBottom: 14,
          animation: "v2-bounce 2s ease-in-out infinite",
        }}
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke={accent}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: 100,
            strokeDashoffset: 0,
            animation: "v2-check 1s cubic-bezier(0.4,0,0.2,1) 0.2s forwards",
            opacity: 0,
          }}
        >
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: "var(--zoca-text)",
          marginBottom: 6,
          letterSpacing: "-0.01em",
        }}
      >
        {title}
      </div>
      {subtitle && (
        <div
          style={{
            fontSize: 13,
            color: "var(--zoca-text-2)",
            lineHeight: 1.5,
            maxWidth: 420,
            margin: "0 auto",
          }}
        >
          {subtitle}
        </div>
      )}
    </div>
  );
}

export default EmptyState;

// Phase 33.brand-watchfire-PR10 — idle state (spec §11 rows 55-57).
// Replaces the bouncing-checkmark visual for "all-clear" empty states
// (e.g. "You're caught up.", "No one's gone silent.") with the banked-
// ember glow, rotating-in motto, and drifting Brass particles. Filter-
// empty / pinned-none / snoozed-none variants keep the existing visual.
function BeaconIdleState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="beacon-idle">
      {/* #57 Faint Brass particles drift up */}
      <div className="beacon-idle-particles" aria-hidden>
        <span className="beacon-particle beacon-particle-1" />
        <span className="beacon-particle beacon-particle-2" />
        <span className="beacon-particle beacon-particle-3" />
        <span className="beacon-particle beacon-particle-4" />
        <span className="beacon-particle beacon-particle-5" />
        <span className="beacon-particle beacon-particle-6" />
      </div>

      {/* #55 Banked-ember illustration */}
      <svg
        className="beacon-banked-ember"
        width="80"
        height="80"
        viewBox="0 0 80 80"
        fill="none"
        aria-hidden
      >
        <defs>
          <radialGradient id="beacon-idle-ember-glow" cx="50%" cy="65%" r="55%">
            <stop offset="0%" stopColor="#C8431D" stopOpacity="0.55" />
            <stop offset="60%" stopColor="#C8431D" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#C8431D" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* glow halo behind the flame */}
        <circle
          cx="40"
          cy="50"
          r="34"
          fill="url(#beacon-idle-ember-glow)"
          className="beacon-ember-halo"
        />
        {/* deep ember base — banked logs */}
        <path
          d="M 22 64 Q 40 70, 58 64 Q 56 62, 50 60 L 48 62 L 44 58 L 40 62 L 36 58 L 32 62 L 30 60 Q 24 62, 22 64 Z"
          fill="#7C2D12"
        />
        {/* mid-flame ember */}
        <path
          d="M 40 30 Q 28 50, 34 60 Q 38 50, 40 46 Q 42 50, 46 60 Q 52 50, 40 30 Z"
          fill="#C8431D"
          className="beacon-ember-inner"
        />
        {/* core flame — gold */}
        <path
          d="M 40 40 Q 36 52, 39 58 Q 40 53, 41 58 Q 44 52, 40 40 Z"
          fill="#FBBF24"
          className="beacon-ember-core"
        />
      </svg>

      <div className="beacon-idle-title">{title}</div>
      {subtitle && <div className="beacon-idle-sub">{subtitle}</div>}

      {/* #56 Motto rotates in slowly */}
      <div className="beacon-idle-motto">A signal worth following.</div>
    </div>
  );
}

