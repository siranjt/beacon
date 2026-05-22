"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (3 hex/rgba + 0 tailwind-rose swept)
import { useEffect, useRef, useState } from "react";
import { useToast } from "./Toast";
import { AnimatedNumber } from "./AnimatedNumber";
import { useMagnetic } from "@/lib/customer/hooks/useMagnetic";

type Props = {
  showing?: number;
  total?: number;
  generatedAt?: string | null;
  amName?: string | null;
  pod?: string | null;
};

export function V2RefreshBar({ showing, total, generatedAt, amName, pod }: Props) {
  const { showToast } = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const magneticRef = useMagnetic<HTMLButtonElement>({ strength: 0.18, radius: 70 });

  // Phase 33.brand-watchfire-PR8-47 — shimmer the timestamp when /api/snapshot
  // returns fresh data. Per spec §11 row 47: 800ms gradient sweep on update.
  const [shimmer, setShimmer] = useState(false);
  const prevGeneratedAtRef = useRef<string | null | undefined>(generatedAt);
  useEffect(() => {
    if (
      prevGeneratedAtRef.current != null &&
      prevGeneratedAtRef.current !== generatedAt
    ) {
      setShimmer(true);
      const t = setTimeout(() => setShimmer(false), 850);
      prevGeneratedAtRef.current = generatedAt;
      return () => clearTimeout(t);
    }
    prevGeneratedAtRef.current = generatedAt;
  }, [generatedAt]);

  // Phase 33.brand-watchfire-T4-caught — replay the "✓ caught" beat for 1.5s
  // on mount if a refresh just completed (via sessionStorage handoff).
  const [caught, setCaught] = useState(false);
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
    setCaught(true);
    const t = setTimeout(() => {
      setCaught(false);
      try {
        window.sessionStorage.removeItem("beacon_refresh_caught_at");
      } catch {
        /* noop */
      }
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/v2/refresh", { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Refresh failed");
      window.location.reload();
    } catch (e) {
      showToast(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`, { type: "error", duration: 5000 });
      setRefreshing(false);
    }
  }

  const time = generatedAt
    ? new Date(generatedAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
    : "—";
  const date = generatedAt ? new Date(generatedAt).toISOString().slice(0, 10) : "";

  return (
    <div
      // Phase 33.brand-watchfire-T5 — refresh bar on Light Parchment.
      className="beacon-refresh-card mx-6 mb-4 rounded-2xl border border-zoca-border bg-zoca-bg-soft px-5 py-3.5 flex items-center justify-between flex-wrap gap-3"
      style={{ boxShadow: "0 4px 18px rgba(11,5,29,0.04)" }}
    >
      <div className="flex items-center gap-5 flex-wrap text-[12px] text-zoca-text">
        <span>
          <span className="zoca-micro-label">Showing</span>{" "}
          <strong className="ml-1.5 font-semibold" style={{ fontVariantNumeric: "tabular-nums" }}>
            <AnimatedNumber value={showing ?? 0} /> / <AnimatedNumber value={total ?? 0} />
          </strong>
        </span>
        <span className="text-zoca-text-3">·</span>
        <span>
          <span className="zoca-micro-label">Last refresh</span>{" "}
          <strong
            className={`ml-1.5 font-semibold${shimmer ? " beacon-shimmer" : ""}`}
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {time}
          </strong>
        </span>
        {date && (
          <>
            <span className="text-zoca-text-3">·</span>
            <span className="text-zoca-text-2 text-[11px]">
              {date}
              {amName ? ` · ${amName}` : ""}
              {pod ? ` · ${pod}` : ""}
            </span>
          </>
        )}
      </div>
      <button
        ref={magneticRef}
        onClick={handleRefresh}
        disabled={refreshing}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-semibold cursor-pointer transition disabled:opacity-50"
        style={{
          background: "transparent",
          color: "var(--zoca-pink)",
          border: "1px solid rgba(200, 67, 29, 0.32)",
          letterSpacing: "-0.005em",
        }}
        onMouseEnter={(e) => {
          if (!refreshing) {
            e.currentTarget.style.boxShadow = "0 0 18px rgba(252, 228, 214, 0.4)";
            e.currentTarget.style.background = "rgba(124, 45, 18, 0.04)";
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.boxShadow = "";
          e.currentTarget.style.background = "transparent";
        }}
      >
        <span
          style={{
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            border: "1.5px solid currentColor",
            display: "inline-block",
          }}
        />
        {caught ? "✓ caught" : refreshing ? "Catching signals…" : "Refresh live data"}
      </button>
    </div>
  );
}

export default V2RefreshBar;
