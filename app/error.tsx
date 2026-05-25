"use client";

/**
 * Umbrella root error boundary. Phase E-9.
 *
 * Next.js App Router renders this when an error escapes any nested
 * boundary. Replaces the default "Application error: a client-side
 * exception has occurred (see browser console for more information)"
 * white screen with a navigable parchment-skinned page.
 *
 * `reset()` re-renders the broken segment. If that fails again, the
 * fallback stays visible — there's no infinite loop.
 */

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to telemetry so we can see global crashes in the activity feed.
    try {
      if (typeof window !== "undefined" && navigator?.sendBeacon) {
        const payload = JSON.stringify({
          agent: "umbrella",
          event_name: "api_call",
          surface: "auth",
          metadata: {
            kind: "global_error_boundary",
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
    // eslint-disable-next-line no-console
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--zoca-bg, #F0E4CC)",
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
          maxWidth: 480,
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
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 22,
            fontWeight: 500,
            color: "#2B1F14",
            marginBottom: 8,
          }}
        >
          Something tripped on the way here.
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#6E5F50",
            marginBottom: 18,
            lineHeight: 1.5,
          }}
        >
          The error has been logged. You can retry the page, or head back to the
          launcher and try a different agent.
        </div>

        {error.digest && (
          <div
            style={{
              fontSize: 11,
              color: "#8B7A66",
              fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
              marginBottom: 18,
            }}
          >
            Error digest: {error.digest}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
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
