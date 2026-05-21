"use client";

import type { Agent } from "@/lib/config";

export default function LauncherCard({ agent }: { agent: Agent }) {
  const isExternal = agent.kind === "external";

  return (
    <a
      href={agent.route}
      target={isExternal ? "_self" : undefined}
      className="beacon-card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        textDecoration: "none",
        color: "inherit",
        position: "relative",
        overflow: "hidden",
      }}
      onClick={() => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("beacon:mark-flare"));
        }
      }}
    >
      {/* Accent rule top — color identifies the agent */}
      <span
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: agent.accent,
        }}
        aria-hidden
      />

      <div
        style={{
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSize: 18,
          fontWeight: 600,
          color: "var(--zoca-text)",
          letterSpacing: "-0.005em",
          marginTop: 8,
        }}
      >
        {agent.name}
      </div>

      <div
        style={{
          fontFamily: "-apple-system, Inter, system-ui, sans-serif",
          fontSize: 12,
          color: "var(--zoca-text-2)",
          lineHeight: 1.55,
        }}
      >
        {agent.description}
      </div>

      <div
        style={{
          marginTop: "auto",
          paddingTop: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontFamily: "-apple-system, Inter, system-ui, sans-serif",
          fontSize: 11,
          letterSpacing: "0.05em",
          color: "var(--zoca-text-3)",
        }}
      >
        <span style={{ textTransform: "uppercase" }}>
          {isExternal ? "External · v1" : "Live"}
        </span>
        <span style={{ color: agent.accent, fontWeight: 600 }}>Open →</span>
      </div>
    </a>
  );
}
