"use client";

/**
 * Client-side "Bootstrap from BaseSheet" button for /admin/keeper/enrichment-status.
 *
 * Fires the one-time META-A2 endpoint that pre-populates every active customer's
 * Keeper with their BaseSheet facts (AE name, MRR, integration state, sold-at
 * date). Idempotent — re-running on customers who already have the facts is a
 * no-op (skipped via existing-fact probe). The endpoint accepts:
 *   { all_active: true }   — bootstrap every active customer (~900)
 *   { entity_ids: [...] }  — bootstrap a specific list
 *
 * This button fires the all_active path. Expected wall-time: ~2-3 minutes for
 * 900 customers. The button stays disabled the whole time and surfaces the
 * counter envelope on completion.
 */

import { useState } from "react";

interface BootstrapResult {
  ok: boolean;
  elapsed_ms?: number;
  entities_processed: number;
  facts_written: number;
  facts_skipped_idempotent: number;
  errors: string[];
}

export default function BootstrapButton() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BootstrapResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onClick() {
    if (
      !window.confirm(
        "Bootstrap Keeper for ALL active customers from BaseSheet? This is the one-time backfill. Idempotent — safe to re-run, but it takes 2-3 minutes against ~900 customers.",
      )
    ) {
      return;
    }
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const res = await fetch(
        "/api/admin/keeper/bootstrap-from-basesheet",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ all_active: true }),
        },
      );
      const j = (await res.json()) as BootstrapResult;
      if (!res.ok) {
        setErr(`HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      } else {
        setResult(j);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={running}
        style={{
          padding: "0.55rem 1.1rem",
          borderRadius: 8,
          border: "1px solid var(--zoca-border)",
          background: running ? "var(--zoca-bg-tint)" : "var(--zoca-ember)",
          color: running ? "var(--zoca-text)" : "var(--zoca-parchment)",
          cursor: running ? "wait" : "pointer",
          fontFamily: "inherit",
          fontWeight: 600,
          fontSize: "0.9rem",
        }}
      >
        {running ? "Bootstrapping…" : "Bootstrap from BaseSheet"}
      </button>
      {err && (
        <div
          style={{
            fontSize: "0.78rem",
            color: "var(--zoca-pink-bright)",
            maxWidth: 360,
            textAlign: "right",
          }}
        >
          {err}
        </div>
      )}
      {result && (
        <div
          style={{
            fontSize: "0.78rem",
            color: "var(--zoca-text-2)",
            maxWidth: 360,
            textAlign: "right",
            lineHeight: 1.4,
          }}
        >
          {result.entities_processed} entities · {result.facts_written} facts written ·{" "}
          {result.facts_skipped_idempotent} already present ·{" "}
          {result.errors.length} errors
          {result.elapsed_ms !== undefined && ` · ${result.elapsed_ms}ms`}
        </div>
      )}
    </div>
  );
}
