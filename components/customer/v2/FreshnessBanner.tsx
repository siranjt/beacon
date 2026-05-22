"use client";
import { useState } from "react";
import { useToast } from "./Toast";

type Props = {
  generatedAt?: string | null;
};

function relativeAge(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function FreshnessBanner({ generatedAt }: Props) {
  const { showToast } = useToast();
  const [refreshing, setRefreshing] = useState(false);

  if (!generatedAt) return null;

  const ageMs = Date.now() - Date.parse(generatedAt);
  if (!Number.isFinite(ageMs) || ageMs < 24 * 60 * 60 * 1000) return null;

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

  // Phase 17.B.1 — light-theme amber banner (Zoca tokens).
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
    </div>
  );
}

export default FreshnessBanner;
