"use client";

import type { Agent } from "@/lib/config";
import { isAgentLocked } from "@/lib/config";
import { useActivityLogger } from "@/components/hooks/use-activity-logger";

export default function LauncherCard({ agent }: { agent: Agent }) {
  const isExternal = agent.kind === "external";
  const locked = isAgentLocked(agent.id);
  // Phase E-8 — log every launcher card click. Tagged as 'umbrella' since
  // the click happens before the user enters an agent's route group.
  const log = useActivityLogger("umbrella");

  // 2026-06-12 — locked agents render as non-interactive cards. We still
  // surface the title + description so AMs know the agent exists; we just
  // skip navigation and show a small "Will be operational shortly" status.
  // Anyone who routes to the page directly hits the MaintenanceCurtain via
  // the route-group layout, so the lock is enforced server-side regardless.
  if (locked) {
    return (
      <div
        className="beacon-card"
        aria-disabled="true"
        title="Will be operational shortly"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          color: "inherit",
          position: "relative",
          overflow: "hidden",
          cursor: "not-allowed",
          opacity: 0.55,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: agent.accent,
            opacity: 0.5,
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
          <span style={{ textTransform: "uppercase" }}>Maintenance</span>
          <span
            style={{
              color: "var(--zoca-text-2)",
              fontStyle: "italic",
              fontFamily: 'Georgia, "Times New Roman", serif',
            }}
          >
            Will be operational shortly
          </span>
        </div>
      </div>
    );
  }

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
        log("launcher_card_clicked", {
          surface: "launcher",
          metadata: { agent_id: agent.id, agent_name: agent.name, kind: agent.kind },
        });
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
