"use client";
// Phase 33.brand-watchfire-T11 — fixed-center sign-in-style ambient lockup.

/**
 * BeaconAmbient
 *
 * Persistent page-level decoration. Mirrors the sign-in screen lockup
 * (BeaconMark + cream halo + pulse rings + rising embers + BEACON
 * wordmark + tagline + sparkle divider) but pinned to the viewport
 * center via `position: fixed`, so it stays anchored as the user
 * scrolls dashboard content.
 *
 * Layer opacity 32% — the lockup whispers behind cards rather than
 * competing with them. Cards use Light Parchment + backdrop-blur in
 * their own treatment to read cleanly on top.
 *
 * aria-hidden + pointer-events: none — purely decorative.
 *
 * Mounted once each in V2Dashboard (AM view) and V2ManagerDashboard
 * (Manager view).
 */
export function BeaconAmbient() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: 0.32,
      }}
    >
      <svg
        viewBox="0 0 500 420"
        width="500"
        height="420"
        preserveAspectRatio="xMidYMid meet"
        style={{ overflow: "visible" }}
      >
        {/* 4 concentric pulse rings — Ember + Brass alternating. */}
        {[0, 1.25, 2.5, 3.75].map((begin, i) => (
          <circle
            key={i}
            cx="250"
            cy="180"
            r="50"
            fill="none"
            stroke={i % 2 === 0 ? "#C8431D" : "#D9A441"}
            strokeWidth="1"
          >
            <animate
              attributeName="r"
              from="50"
              to="220"
              begin={`${begin}s`}
              dur="5s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              from="0.5"
              to="0"
              begin={`${begin}s`}
              dur="5s"
              repeatCount="indefinite"
            />
          </circle>
        ))}

        {/* Cream halo behind the mark — the "candle glow". */}
        <circle cx="250" cy="175" r="55" fill="#FEF3C7" opacity="0.55" />

        {/* The Mark — 4 tower tiers + 4 blazing flame layers. */}
        <g transform="translate(250, 180) scale(2.4)">
          <rect x="-6" y="-4" width="12" height="4" fill="#2B1F14" />
          <rect x="-5" y="-10" width="10" height="4" fill="#2B1F14" />
          <rect x="-4" y="-16" width="8" height="4" fill="#2B1F14" />
          <rect x="-3" y="-22" width="6" height="4" fill="#2B1F14" />
          <path
            d="M 0 -32 C 4 -28 5 -23 3 -21 L -3 -21 C -5 -23 -4 -28 0 -32 Z"
            fill="#C8431D"
            className="beacon-flame-1"
            style={{ transformOrigin: "0px -21px" }}
          />
          <path
            d="M 0 -30 C 3.4 -27 4 -23 2.5 -21 L -2.5 -21 C -4 -23 -3.4 -27 0 -30 Z"
            fill="#E85A2B"
            opacity="0.85"
            className="beacon-flame-2"
            style={{ transformOrigin: "0px -21px" }}
          />
          <path
            d="M 0 -27 C 2 -24 3 -21 2 -19 L -2 -19 C -3 -21 -2 -24 0 -27 Z"
            fill="#D9A441"
            className="beacon-flame-3"
            style={{ transformOrigin: "0px -19px" }}
          />
          <path
            d="M 0 -25 C 1.2 -23 1.5 -21 1 -19 L -1 -19 C -1.5 -21 -1.2 -23 0 -25 Z"
            fill="#FBBF24"
            className="beacon-flame-4"
            style={{ transformOrigin: "0px -19px" }}
          />
        </g>

        {/* 6 rising embers — drift upward from the flame tip (y ~124). */}
        <circle cx="246" cy="123" r="1.6" fill="#C8431D" className="beacon-ember-1" />
        <circle cx="254" cy="123" r="1.8" fill="#FBBF24" className="beacon-ember-5" />
        <circle cx="241" cy="126" r="1.5" fill="#E85A2B" className="beacon-ember-2" />
        <circle cx="251" cy="124" r="1.4" fill="#D9A441" className="beacon-ember-3" />
        <circle cx="259" cy="125" r="1.5" fill="#E85A2B" className="beacon-ember-6" />
        <circle cx="238" cy="124" r="1.6" fill="#C8431D" className="beacon-ember-4" />

        {/* BEACON wordmark — Georgia, 38px, letter-spacing 16. */}
        <text
          x="250"
          y="290"
          textAnchor="middle"
          style={{
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: "38px",
            fontWeight: 400,
            fill: "#2B1F14",
            letterSpacing: "16px",
          }}
        >
          BEACON
        </text>

        {/* Tagline — Inter, 11px, letter-spacing 4, Faded Smoke. */}
        <text
          x="250"
          y="320"
          textAnchor="middle"
          style={{
            fontFamily: '-apple-system, Inter, system-ui, sans-serif',
            fontSize: "11px",
            fontWeight: 400,
            fill: "#8B7A66",
            letterSpacing: "4px",
          }}
        >
          A SIGNAL WORTH FOLLOWING
        </text>

        {/* Sparkle divider — two brass lines + a tiny gold diamond. */}
        <line x1="180" y1="345" x2="240" y2="345" stroke="#D9A441" strokeWidth="0.5" opacity="0.5" />
        <line x1="260" y1="345" x2="320" y2="345" stroke="#D9A441" strokeWidth="0.5" opacity="0.5" />
        <path d="M 250 340 L 252 345 L 250 350 L 248 345 Z" fill="#D9A441" opacity="0.7" />
      </svg>
    </div>
  );
}

export default BeaconAmbient;
