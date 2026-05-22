import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Watchfire palette — backed by CSS variables in app/globals.css
        "zoca-bg": "var(--zoca-bg)",
        "zoca-bg-soft": "var(--zoca-bg-soft)",
        "zoca-bg-tint": "var(--zoca-bg-tint)",
        "zoca-text": "var(--zoca-text)",
        "zoca-text-2": "var(--zoca-text-2)",
        "zoca-text-3": "var(--zoca-text-3)",
        "zoca-pink": "var(--zoca-pink)",
        "zoca-pink-bright": "var(--zoca-pink-bright)",
        "zoca-pink-soft": "var(--zoca-pink-soft)",
        "zoca-red": "var(--zoca-red)",
        "zoca-red-soft": "var(--zoca-red-soft)",
        "zoca-amber": "var(--zoca-amber)",
        "zoca-amber-soft": "var(--zoca-amber-soft)",
        "zoca-green": "var(--zoca-green)",
        "zoca-green-deep": "var(--zoca-green-deep)",
        "zoca-green-soft": "var(--zoca-green-soft)",
        "zoca-blue": "var(--zoca-blue)",
        "zoca-blue-strong": "var(--zoca-blue-strong)",
        "zoca-border": "var(--zoca-border)",
        "zoca-border-2": "var(--zoca-border-2)",

        // ─────────────────────────────────────────────────────────────
        // Escalation Beacon palette — REMAPPED to Watchfire during the
        // Phase C polish. Token names preserved so the 1194-line
        // EscalationsBrowser and the 5 chart components don't need
        // class-by-class edits — they just inherit the new colors.
        // ─────────────────────────────────────────────────────────────
        // Surfaces
        bg: "#F0E4CC",      // Parchment (page canvas)
        panel: "#F8EFD7",   // Light Parchment (card surface)
        panel2: "#EBE0C2",  // Buff (sub-cards)
        panel3: "#F8EFD7",  // Light Parchment (alt elevated)
        border: "#D4C29B",  // Aged Brass
        border2: "#C2A975", // Darker Brass
        // Text
        text: "#2B1F14",    // Char
        text2: "#6E5F50",   // Smoke
        muted: "#8B7A66",   // Faded Smoke
        muted2: "#6E5F50",  // Smoke
        // Brand / accent — Escalation = Deep Crimson primary, Ember warm
        brand: "#C8431D",       // Ember
        brandDeep: "#7C2D12",   // Deep Crimson
        brandSoft: "#FCE4D6",   // Light Ember
        cobalt: "#2A4D5C",      // Sea Lapis (re-purposed from cobalt)
        cobaltSoft: "#D8E1E6",  // Lapis soft
        violet: "#D9A441",      // Brass (re-purposed from violet)
        violetSoft: "#F5E6BB",  // Pale Brass
        accent: "#7C2D12",      // Deep Crimson (Escalation card accent)
        accentSoft: "#F5C9B6",  // Faded Crimson
        // Semantic
        ok: "#4A7C59",          // Patina
        okSoft: "#DAE5DC",      // Pale Patina
        warn: "#D9A441",        // Brass
        warnSoft: "#F5E6BB",    // Pale Brass
        err: "#7C2D12",         // Deep Crimson
        errSoft: "#F5C9B6",     // Faded Crimson
        // Channel ramp — distinct hues from Watchfire vocabulary so the
        // donut + timeline strips stay legible at a glance
        chApp: "#2A4D5C",       // Sea Lapis
        chEmail: "#D9A441",     // Brass
        chPhone: "#4A7C59",     // Patina
        chVideo: "#C8431D",     // Ember
        chSms: "#7C2D12",       // Deep Crimson
        // Classification ramp
        churn: "#7C2D12",       // Deep Crimson
        retention: "#D9A441",   // Brass
        subSupport: "#2A4D5C",  // Sea Lapis
        paidOff: "#4A7C59",     // Patina
        subCancel: "#C8431D",   // Ember

        // ─────────────────────────────────────────────────────────────
        // Post-Payment Reviews tokens — REMAPPED to Watchfire. The
        // component tree references `text-ink`, `bg-surface`, `border-line`,
        // `bg-elevated`, `text-accent-{color}` etc., and before this remap
        // those classes resolved to nothing (no CSS rule emitted, since
        // they weren't declared in either Tailwind config or globals.css).
        // Defining them as flat color tokens here makes every existing
        // class reference render Watchfire colors without rewriting the
        // ~1500 lines of post-payment JSX. Pattern matches the Escalation
        // remap block above.
        // ─────────────────────────────────────────────────────────────
        // Text + surfaces
        ink: "#2B1F14",            // Char (primary text)
        "ink-muted": "#6E5F50",    // Smoke (muted text)
        "ink-dim": "#8B7A66",      // Faded Smoke (dim text)
        surface: "#F8EFD7",        // Light Parchment (card surface)
        elevated: "#EBE0C2",       // Buff (hover/elevated surface)
        line: "#D4C29B",           // Aged Brass (default border)
        // Accent ramp — flat tokens (used as text-/bg-/border- prefixes).
        // Pair each hue with a -bg companion that's a 6-8% tint for badge
        // backgrounds. Hex picks: green = Patina, yellow = Brass, red =
        // Ember, blue = Sea Lapis, purple = Deep Crimson, pink = Deep
        // Crimson (purple/pink are visually adjacent in Watchfire).
        "accent-line": "#C2A975",
        "accent-green": "#4A7C59",
        "accent-green-bg": "#DAE5DC",
        "accent-yellow": "#D9A441",
        "accent-yellow-bg": "#F5E6BB",
        "accent-red": "#C8431D",
        "accent-red-bg": "#F5C9B6",
        "accent-blue": "#2A4D5C",
        "accent-blue-bg": "#D8E1E6",
        "accent-purple": "#7C2D12",
        "accent-purple-bg": "#F5C9B6",
        "accent-pink": "#7C2D12",
        "accent-pink-bg": "#F5C9B6",
      },
      borderRadius: {
        zoca: "10px",
        "zoca-lg": "14px",
        "zoca-pill": "9999px",
        "zoca-sm": "6px",
      },
      boxShadow: {
        "zoca-sm": "0 1px 3px rgba(43, 31, 20, 0.06)",
        "zoca-md": "0 4px 18px rgba(43, 31, 20, 0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
