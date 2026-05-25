"use client";

/**
 * AgentErrorScreen — Phase E-9.
 *
 * Shared fallback UI for route-segment error.tsx files inside each agent
 * group. Renders a parchment card with the agent label, error message,
 * "Retry / Back to launcher / Back to {agent} home" actions, and an
 * optional Next.js error digest for ops to grep against.
 *
 * Used by:
 *   - app/(customer)/customer/error.tsx
 *   - app/(performance)/performance/error.tsx
 *   - app/(escalation)/escalation/error.tsx
 *   - app/(post-payment)/post-payment/error.tsx
 */

import { useEffect } from "react";

export function AgentErrorScreen({
  agentLabel,
  agentPath,
  error,
  reset,
}: {
  agentLabel: string;
  /** Path users should be sent back to for this agent's home (e.g. "/customer"). */
  agentPath: string;
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Telemetry — record agent-level boundary catches in the activity log.
    try {
      if (typeof window !== "undefined" && navigator?.sendBeacon) {
        const payload = JSON.stringify({
          agent: "umbrella",
          event_name: "api_call",
          surface: "auth",
          metadata: {
            kind: "agent_error_boundary",
            agent_label: agentLabel,
            message: error.message?.slice(0, 200),
            digest: error.digest,
            stack: error.stack?.slice(0, 500),
          },
        });
        navigator.sendBeacon(
          "/api/activity",
          new Blob([payload], { type: "application/json" }),
        );
      }
    } catch {
      /* never crash from within the error boundary */
    }
  }, [agentLabel, error]);

  return (
    <main
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: "-apple-system, Inter, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 500,
          width: "100%",
          background: "#F8EFD7",
          border: "1px solid #D4C29B",
          borderRadius: 14,
          padding: "28px 32px",
          boxShadow: "0 16px 40px -16px rgba(43,31,20,0.35)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "#8B7A66",
            marginBottom: 10,
          }}
        >
          {agentLabel}
        </div>
        <div
          style={{
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 22,
            fontWeight: 500,
            color: "#2B1F14",
            marginBottom: 8,
          }}
        >
          {agentLabel} hit a snag.
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#6E5F50",
            marginBottom: 18,
            lineHeight: 1.5,
          }}
        >
          The error&apos;s been logged. Other agents are unaffected — you can
          retry, head back to {agentLabel.toLowerCase()} home, or jump to the
          umbrella launcher.
        </div>

        {error.digest && (
          <div
            style={{
              fontSize: 11,
              color: "#8B7A66",
              fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
              marginBottom: 14,
            }}
          >
            Digest: {error.digest}
          </div>
        )}

        <details
          style={{
            fontSize: 11,
            color: "#6E5F50",
            marginBottom: 18,
            textAlign: "left",
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              fontFamily: "-apple-system, Inter, system-ui, sans-serif",
              userSelect: "none",
            }}
          >
            Show error details
          </summary>
          <pre
            style={{
              marginTop: 8,
              padding: 10,
              background: "#F0E4CC",
              border: "1px solid #D4C29B",
              borderRadius: 6,
              fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
              fontSize: 11,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 160,
              overflowY: "auto",
            }}
          >
            {error.message || "Unknown error"}
          </pre>
        </details>

        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #2B1F14",
              background: "#2B1F14",
              color: "#F0E4CC",
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 13,
            }}
          >
            Retry
          </button>
          <a
            href={agentPath}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #D4C29B",
              background: "transparent",
              color: "#2B1F14",
              fontWeight: 500,
              textDecoration: "none",
              fontFamily: "inherit",
              fontSize: 13,
            }}
          >
            {agentLabel} home
          </a>
          <a
            href="/"
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #D4C29B",
              background: "transparent",
              color: "#2B1F14",
              fontWeight: 500,
              textDecoration: "none",
              fontFamily: "inherit",
              fontSize: 13,
            }}
          >
            Back to launcher
          </a>
        </div>
      </div>
    </main>
  );
}
