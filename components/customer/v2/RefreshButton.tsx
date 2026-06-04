"use client";

// Phase 33.brand-watchfire-pink-sweep-refreshbutton (2 V2-pink values swept).
import { useEffect, useState, useTransition } from "react";

/**
 * Manual refresh button — wired into the V2 dashboard headers.
 *
 * POSTs to /api/v2/refresh (gated by the dashboard basic-auth middleware),
 * which re-runs compose on the current stage data. On success, hard-reloads
 * the page so the freshly-stored snapshot is picked up. On failure, surfaces
 * the error inline and auto-resets to idle after 5 s.
 *
 * Compose-only: does NOT re-pull from Chargebee/HubSpot/Metabase. The daily
 * 22:00 UTC cron still owns the upstream stages.
 *
 * Phase 17.D — restyled to the Zoca brand light theme (pink outline pill
 * matching V2RefreshBar's "Refresh live data" CTA).
 */
export function RefreshButton() {
  // Phase 33.brand-watchfire-PR8 — "caught" status added for the 1.5s success beat.
  const [status, setStatus] = useState<"idle" | "refreshing" | "caught" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Phase 33.brand-watchfire-T4-caught — on mount, check for a recent refresh
  // sessionStorage handoff and replay the "✓ caught" beat for 1.5s before
  // reverting to idle. 8s staleness window prevents ghost beats from old reloads.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let ts: string | null = null;
    try {
      ts = window.sessionStorage.getItem("beacon_refresh_caught_at");
    } catch {
      return;
    }
    if (!ts) return;
    const elapsed = Date.now() - parseInt(ts, 10);
    if (Number.isNaN(elapsed) || elapsed < 0 || elapsed > 8000) {
      try {
        window.sessionStorage.removeItem("beacon_refresh_caught_at");
      } catch {
        /* noop */
      }
      return;
    }
    setStatus("caught");
    const t = setTimeout(() => {
      setStatus("idle");
      try {
        window.sessionStorage.removeItem("beacon_refresh_caught_at");
      } catch {
        /* noop */
      }
    }, 1500);
    return () => clearTimeout(t);
  }, []);
  const [, startTransition] = useTransition();

  async function handleClick() {
    setStatus("refreshing");
    setErrorMsg(null);
    // Phase 33.brand-watchfire-PR7-36 — desaturate cards while the refresh
    // is in flight. Class is removed on error; page reload handles cleanup
    // on success.
    if (typeof document !== "undefined") {
      document.body.classList.add("beacon-refreshing");
    }
    try {
      const res = await fetch("/api/v2/refresh", { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || "Refresh failed");
      }
      // Phase 33.brand-watchfire-T4-caught — hand off the "✓ caught" beat
      // to the next page mount via sessionStorage so it shows alongside the
      // fresh data instead of before the page swap. Reload happens immediately.
      if (typeof window !== "undefined") {
        try {
          window.sessionStorage.setItem(
            "beacon_refresh_caught_at",
            String(Date.now()),
          );
        } catch {
          /* sessionStorage disabled — degrade gracefully */
        }
      }
      startTransition(() => {
        window.location.reload();
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus("error");
      setErrorMsg(msg);
      // Fix: remove the desaturation class on error so the session isn't
      // left stuck in "refreshing" visual state (which previously persisted
      // until a manual page reload).
      if (typeof document !== "undefined") {
        document.body.classList.remove("beacon-refreshing");
      }
      setTimeout(() => setStatus("idle"), 5000);
    }
  }

  const refreshing = status === "refreshing";
  return (
    <button
      onClick={handleClick}
      disabled={refreshing}
      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        background: "transparent",
        color: "var(--zoca-pink)",
        border: "1px solid rgba(200, 67, 29, 0.32)",
        letterSpacing: "-0.005em",
      }}
      onMouseEnter={(e) => {
        if (!refreshing) {
          e.currentTarget.style.background = "rgba(124, 45, 18, 0.06)";
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
      title={errorMsg || "Re-run compose to refresh the snapshot from current stage data"}
    >
      {status === "refreshing" ? (
        <>
          <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Catching signals…
        </>
      ) : status === "caught" ? (
        // Phase 33.brand-watchfire-PR8 — success beat.
        <>
          <span aria-hidden>✓</span>
          caught
        </>
      ) : status === "error" ? (
        <>
          <span aria-hidden>⚠</span>
          Failed — retry
        </>
      ) : (
        <>
          <span aria-hidden className="beacon-refresh-spin">↻</span>
          Refresh
        </>
      )}
    </button>
  );
}
