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
