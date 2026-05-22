// ---------------------------------------------------------------------------
// Phase 23.A — shared chart-theme constants.
//
// Centralizes color palette, animation timing, and tooltip style so every
// chart component in /v2 stays visually coordinated. The palette mirrors
// the Zoca brand tokens used elsewhere in the dashboard (pink for RED,
// amber for YELLOW, green for healthy) — keeping these in one module
// means the day we re-skin to dark mode, only one file changes.
//
// Animation timing matches Phase 22's 1100ms ease-out cubic curve so chart
// entrance feels continuous with the rest of the UI (AnimatedNumber on KPI
// tiles, card stagger, etc.).
// ---------------------------------------------------------------------------

// Phase 33.brand-watchfire — chart palette flips to Watchfire.
// Names are kept (red, amber, green, blue, …) to avoid churn at
// every callsite; semantic meaning shifts per spec §7.
export const CHART_COLORS = {
  red: "#C8431D",                  // Ember
  amber: "#D9A441",                // Brass
  green: "#4A7C59",                // Patina
  blue: "#2A4D5C",                 // Sea Lapis
  purple: "#2A4D5C",               // (legacy alias — folds into Sea Lapis)
  rose: "rgba(200, 67, 29, 0.55)", // Ember @ 55% (for "we silent")
  midnight: "#2B1F14",             // Char
  muted: "#6E5F50",                // Smoke
  bg: "#F8EFD7",                   // Light Parchment
  gridLine: "#EBE0C2",             // Buff (faint)
} as const;

export const CHART_ANIMATION = {
  duration: 1100,
  easing: "easeOutCubic" as const,
};

export const CHART_TOOLTIP_STYLE = {
  backgroundColor: "#0b051d",
  padding: 10,
  cornerRadius: 8,
  // Numeric weight (600) is what Chart.js's TypeScript types accept; the
  // string "600" form renders identically at runtime but trips strict typing
  // in callers that annotate ChartOptions<"line">. See Phase 30.1 hotfix.
  titleFont: { size: 12, weight: 600 },
  bodyFont: { size: 12 },
};
