"use client";

/**
 * SectionErrorBoundary — Phase E-9.
 *
 * React error boundary for individual dashboard sections. Wraps a chart,
 * panel, list, or any subtree that could throw and isolates the failure
 * from the rest of the page.
 *
 * Why a class component? React's error-boundary API is class-only — there's
 * still no useErrorBoundary hook. Keep this dumb and stateless beyond the
 * caught-error tuple.
 *
 * Usage:
 *   <SectionErrorBoundary label="Critical customers">
 *     <RiskyChart data={data} />
 *   </SectionErrorBoundary>
 *
 * Behavior:
 *   - Catches errors thrown during render of any descendant
 *   - Renders a small parchment card with the error message + a "Retry"
 *     button that resets the boundary state (the child will re-mount)
 *   - Logs the error to the console + (in production) to the umbrella
 *     activity log via fetch so we can see component-level failures in
 *     telemetry
 *   - The wrapped subtree fully unmounts on error, so any leaked
 *     setIntervals / event listeners in the broken component get GC'd
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Human label for the section — shown in the fallback + telemetry. */
  label: string;
  /** Optional custom fallback. Falls back to the default parchment card. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export default class SectionErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Always log to the console so devs see the stack in browser DevTools.
    // eslint-disable-next-line no-console
    console.error(
      `[SectionErrorBoundary] ${this.props.label}:`,
      error,
      info.componentStack,
    );

    // Phase E-9 — also forward to Sentry if it's wired. Lazy import so we
    // don't pull in the SDK unless it's available; the require lives in a
    // try/catch so a missing dep never breaks the boundary.
    try {
      if (typeof window !== "undefined") {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Sentry = require("@sentry/nextjs");
        if (Sentry?.captureException) {
          Sentry.captureException(error, {
            tags: {
              kind: "section_error_boundary",
              section: this.props.label,
            },
            extra: { componentStack: info.componentStack },
          });
        }
      }
    } catch {
      /* Sentry not available — fine */
    }

    // Fire telemetry to the umbrella activity log. Fire-and-forget — never
    // throw from inside an error boundary.
    try {
      if (typeof window !== "undefined" && navigator?.sendBeacon) {
        const payload = JSON.stringify({
          agent: "umbrella",
          event_name: "api_call",
          surface: "auth",
          metadata: {
            kind: "section_error_boundary_caught",
            section: this.props.label,
            message: error.message?.slice(0, 200),
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
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return <FallbackCard label={this.props.label} error={this.state.error} reset={this.reset} />;
    }
    return this.props.children;
  }
}

function FallbackCard({
  label,
  error,
  reset,
}: {
  label: string;
  error: Error;
  reset: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        background: "rgba(200, 67, 29, 0.06)",
        border: "1px solid rgba(200, 67, 29, 0.3)",
        borderRadius: 14,
        padding: "16px 20px",
        fontFamily: "-apple-system, Inter, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 6,
        }}
      >
        <div
          style={{
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 14,
            fontWeight: 500,
            color: "#7C2D12",
          }}
        >
          {label} couldn&apos;t load
        </div>
        <button
          type="button"
          onClick={reset}
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.04em",
            padding: "3px 10px",
            borderRadius: 6,
            border: "1px solid #C8431D",
            background: "transparent",
            color: "#C8431D",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Retry
        </button>
      </div>
      <div
        style={{
          fontSize: 11,
          color: "#6E5F50",
          fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
          wordBreak: "break-word",
        }}
      >
        {error.message || "Unknown error"}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 11,
          color: "#8B7A66",
        }}
      >
        The rest of the page is unaffected. If this keeps happening, ping the
        team — the error is logged in Beacon&apos;s activity stream.
      </div>
    </div>
  );
}
