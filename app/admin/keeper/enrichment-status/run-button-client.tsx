"use client";

/**
 * Client-side "Run now" button for /admin/keeper/enrichment-status.
 * POSTs to /api/admin/keeper/enrichment-run, surfaces the envelope, and
 * disables itself while the request is in-flight. No optimistic UI —
 * the run takes seconds to ~30s in steady state, which is short enough
 * to wait for the real numbers.
 */

import { useState } from "react";

interface RunResult {
  ok: boolean;
  elapsed_ms: number;
  customers_processed: number;
  facts_written: number;
  facts_refined: number;
  facts_unchanged: number;
  facts_failed: number;
  errors?: string[];
}

export default function EnrichmentRunButton() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onClick() {
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/keeper/enrichment-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = (await res.json()) as RunResult;
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
          background: running ? "var(--zoca-bg-tint)" : "var(--zoca-bg)",
          color: "var(--zoca-text)",
          cursor: running ? "wait" : "pointer",
          fontFamily: "inherit",
          fontWeight: 600,
          fontSize: "0.9rem",
        }}
      >
        {running ? "Running…" : "Run now"}
      </button>
      {err && (
        <div
          style={{
            fontSize: "0.78rem",
            color: "var(--zoca-pink-bright)",
            maxWidth: 320,
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
            maxWidth: 320,
            textAlign: "right",
            lineHeight: 1.4,
          }}
        >
          {result.customers_processed} customers · {result.facts_written} new,{" "}
          {result.facts_refined} refined, {result.facts_unchanged} unchanged,{" "}
          {result.facts_failed} failed · {result.elapsed_ms}ms
        </div>
      )}
    </div>
  );
}
