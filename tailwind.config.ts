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
        // Escalation Beacon palette (utilitarian) — preserved verbatim
        // from zoca-escalation-agent during Phase C migration. These
        // tokens drive the components' existing visual style. A future
        // polish pass can Watchfire-ify them.
        // ─────────────────────────────────────────────────────────────
        bg: "#fafbfc",
        panel: "#ffffff",
        panel2: "#f7f8fb",
        panel3: "#f0f1f5",
        border: "#e5e7eb",
        border2: "#d8dde6",
        text: "#0d1117",
        text2: "#1f2937",
        muted: "#838d9d",
        muted2: "#5a6371",
        brand: "#ff5aa0",
        brandDeep: "#ff3d8a",
        brandSoft: "#fff5fa",
        cobalt: "#3b5bff",
        cobaltSoft: "#eef2ff",
        violet: "#8b4dff",
        violetSoft: "#f3eefc",
        accent: "#3b5bff",
        accentSoft: "#eef2ff",
        ok: "#15803d",
        okSoft: "#e6f7ec",
        warn: "#92400e",
        warnSoft: "#fffbeb",
        err: "#b91c1c",
        errSoft: "#fef2f2",
        chApp: "#3b5bff",
        chEmail: "#8b4dff",
        chPhone: "#22c55e",
        chVideo: "#eab308",
        chSms: "#ff5aa0",
        churn: "#ef4444",
        retention: "#f59e0b",
        subSupport: "#3b5bff",
        paidOff: "#8b4dff",
        subCancel: "#ff5aa0",
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
