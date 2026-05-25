"use client";
import { useState } from "react";
import { useToast } from "./Toast";
import type { DataHealth } from "@/lib/customer/types";

type Props = {
  generatedAt?: string | null;
  /**
   * Phase E-11 — snapshot health surface so we can render per-stage
   * staleness reasons instead of just the wholesale generatedAt age.
   * When provided AND degraded_reasons is non-empty, we render the
   * stage-level banner with specific reasons. Otherwise we fall back
   * to the legacy generatedAt-based banner.
   */
  health?: DataHealth | null;
  /** Whether the viewer can force-refresh (managers + admins). */
  canForceRefresh?: boolean;
};

function relativeAge(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STAGE_LABELS: Record<string, string> = {
  A: "Chargebee subscriptions",
  B: "Comms (chat / email / phone / video / SMS)",
  C: "Mixpanel usage + performance signals",
  D: "HubSpot (deals / notes / calls / contacts)",
};

/**
 * Phase E-11 — translate a `degraded_reasons` token into a human sentence.
 * Tokens are emitted by composeSnapshot in lib/customer/refresh.ts.
 */
function describeReason(reason: string): string | null {
  // stage_X_stale_<hours>h
  const staleMatch = reason.match(/^stage_([abcd])_stale_(\d+)h$/i);
  if (staleMatch) {
    const stage = staleMatch[1].toUpperCase();
    const hours = staleMatch[2];
    return `${STAGE_LABELS[stage] ?? `Stage ${stage}`} last refreshed ${hours}h ago`;
  }
  if (reason === "stage_d_hubspot_unavailable") {
    return "HubSpot data is unavailable — deals / notes / calls / contacts won't show";
  }
  if (reason.startsWith("integrity:")) {
    return reason.replace(/^integrity:\s*/, "Integrity check: ");
  }
  // Per-source HubSpot failures (FIX-B): individual fetches soft-fail
  // independently rather than collapsing into a wholesale yesterday-fallback.
  if (reason.startsWith("hubspot:deals_fetch_failed")) {
    return "HubSpot deals didn't refresh — deal stage / amount may be stale";
  }
  if (reason.startsWith("hubspot:notes_fetch_failed")) {
    return "HubSpot notes didn't refresh — last call summary may be stale";
  }
  if (reason.startsWith("hubspot:calls_fetch_failed")) {
    return "HubSpot calls didn't refresh — recent call history may be stale";
  }
  if (reason.startsWith("hubspot:contacts_fetch_failed")) {
    return "HubSpot contacts didn't refresh — buyer-side org chart may be stale";
  }
  if (reason.startsWith("hubspot:companies_fetch_failed")) {
    return "HubSpot company list didn't refresh — all HubSpot fields fell back to yesterday";
  }
  if (reason.startsWith("hubspot:")) {
    return reason.replace(/^hubspot:\s*/, "HubSpot: ");
  }
  if (reason.startsWith("stage_a_universe_shrank")) {
    return "Active customer universe shrank unexpectedly — Chargebee fetch may have partial data";
  }
  if (reason.startsWith("stage_d_used_yesterday_fallback")) {
    return "Using yesterday's HubSpot data — today's fetch failed atomically";
  }
  // Unknown structured reason — show raw so it's not silently swallowed.
  return reason;
}

export function FreshnessBanner({ generatedAt, health, canForceRefresh = true }: Props) {
  const { showToast } = useToast();
  const [refreshing, setRefreshing] = useState(false);

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

  // ---- Phase E-11 — stage-level degraded banner (preferred) ----
  const reasons = health?.degraded_reasons ?? [];
  if (reasons.length > 0) {
    // Describe each reason; collapse to a short head + tooltip-ready expanded list.
    const described = reasons.map(describeReason).filter(Boolean) as string[];
    const head = described[0];
    const more = described.length - 1;
    return (
      <div
        className="flex items-start justify-between gap-4 border-b px-4 py-2.5 text-sm"
        style={{
          background: "rgba(200, 67, 29, 0.06)",
          borderColor: "rgba(200, 67, 29, 0.28)",
          color: "#7C2D12",
        }}
        role="alert"
        aria-live="polite"
      >
        <div className="flex items-start gap-2 min-w-0">
          <span aria-hidden className="leading-none mt-0.5">⚠</span>
          <div className="min-w-0">
            <div>
              <strong>Some signals are stale.</strong> {head}
              {more > 0 && (
                <span title={described.slice(1).join("\n")} className="cursor-help underline decoration-dotted ml-1">
                  (+{more} more)
                </span>
              )}
            </div>
            <div className="text-xs mt-0.5" style={{ opacity: 0.75 }}>
              Customer identity + billing are still hourly-fresh. Health scores may lag until the next nightly refresh (22:00 UTC).
            </div>
          </div>
        </div>
        {canForceRefresh && (
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition disabled:opacity-50"
            style={{
              background: "rgba(200, 67, 29, 0.10)",
              border: "1px solid rgba(200, 67, 29, 0.36)",
              color: "#7C2D12",
            }}
          >
            {refreshing ? "Catching signals…" : "Force refresh"}
          </button>
        )}
      </div>
    );
  }

  // ---- Legacy fall-back — only generatedAt is known ----
  if (!generatedAt) return null;
  const ageMs = Date.now() - Date.parse(generatedAt);
  if (!Number.isFinite(ageMs) || ageMs < 24 * 60 * 60 * 1000) return null;

  return (
    <div
      className="flex items-center justify-between gap-4 border-b px-4 py-2.5 text-sm"
      style={{
        background: "rgba(245, 158, 11, 0.08)",
        borderColor: "rgba(245, 158, 11, 0.28)",
        color: "#b45309",
      }}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden>⚠</span>
        <span>
          Snapshot is <strong>{relativeAge(ageMs)}</strong> — daily refresh may have failed. Data could be stale.
        </span>
      </div>
      {canForceRefresh && (
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition disabled:opacity-50"
          style={{
            background: "rgba(245, 158, 11, 0.16)",
            border: "1px solid rgba(245, 158, 11, 0.36)",
            color: "#92400e",
          }}
        >
          {refreshing ? "Catching signals…" : "Refresh now"}
        </button>
      )}
    </div>
  );
}

export default FreshnessBanner;
