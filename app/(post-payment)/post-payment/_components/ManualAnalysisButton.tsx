"use client";

import { useState, useEffect, useRef } from "react";

type State = "idle" | "running" | "success" | "error";

/**
 * Manual analysis trigger button for customers that didn't get auto-analyzed
 * (webhook missed, pipeline crashed, etc).
 *
 * Click → POSTs to /api/analyze/[id]?force=true, polls /api/diag/[id] every
 * 5s, shows a ticking timer + spinner while waiting. Reflects success or
 * failure with the matching animation, and offers a Retry on failure.
 */
export function ManualAnalysisButton({
  customerId,
  size = "sm",
}: {
  customerId: string;
  size?: "sm" | "md";
}) {
  const [state, setState] = useState<State>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ABORT_AFTER_SEC = 360; // 6 minutes — beyond plausible run time

  function cleanup() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    timerRef.current = null;
    pollRef.current = null;
  }

  useEffect(() => () => cleanup(), []);

  async function start() {
    setState("running");
    setElapsed(0);
    setError(null);
    const startedAt = Date.now();

    // Tick the on-screen timer every second
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    // Kick the analysis
    try {
      const res = await fetch(`/post-payment/api/analyze/${customerId}?force=true`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status} on POST /api/analyze`);
    } catch (e: any) {
      cleanup();
      setError(e?.message ?? "Failed to start analysis");
      setState("error");
      return;
    }

    // Poll for completion every 5s
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/post-payment/api/diag/${customerId}`, { cache: "no-store" });
        const d = await r.json();
        const status = d?.customer?.status;
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);

        if (status === "ready") {
          cleanup();
          setState("success");
          // Refresh the dashboard after a short victory pause
          setTimeout(() => window.location.reload(), 1500);
        } else if (status === "failed") {
          cleanup();
          setError(d?.customer?.failure_reason?.slice(0, 200) ?? "Analysis failed");
          setState("error");
        } else if (status === "out_of_scope") {
          cleanup();
          setError(d?.customer?.failure_reason?.slice(0, 200) ?? "Customer is out of scope");
          setState("error");
        } else if (elapsedSec > ABORT_AFTER_SEC) {
          cleanup();
          setError(`Analysis still running after ${ABORT_AFTER_SEC}s. Check Vercel logs.`);
          setState("error");
        }
      } catch {
        // Transient poll error — keep polling
      }
    }, 5000);
  }

  const mm = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const ss = (elapsed % 60).toString().padStart(2, "0");
  const padX = size === "md" ? "px-3 py-1.5" : "px-2.5 py-1";

  if (state === "idle") {
    return (
      <button
        onClick={start}
        className={`btn-bounce inline-flex items-center gap-1.5 ${padX} text-xs font-medium rounded-md border border-accent-blue/40 text-accent-blue bg-accent-blue-bg/40 hover:bg-accent-blue-bg hover:border-accent-blue transition`}
      >
        <span aria-hidden>▶</span> Run analysis
      </button>
    );
  }

  if (state === "running") {
    return (
      <div className={`mab-running inline-flex items-center gap-2 ${padX} text-xs rounded-md border border-accent-purple/40 bg-accent-purple-bg/40 text-accent-purple-strong`}>
        <span className="mab-spinner" aria-hidden />
        <span>Analyzing</span>
        <span className="font-mono tabular-nums font-semibold">{mm}:{ss}</span>
      </div>
    );
  }

  if (state === "success") {
    return (
      <div className={`mab-success inline-flex items-center gap-1.5 ${padX} text-xs font-semibold rounded-md border border-accent-green/40 bg-accent-green-bg text-accent-green`}>
        <span className="mab-check" aria-hidden>✓</span> Done — reloading…
      </div>
    );
  }

  // error
  return (
    <div className="inline-flex items-center gap-1.5">
      <button
        onClick={start}
        className={`btn-bounce inline-flex items-center gap-1 ${padX} text-xs font-medium rounded-md border border-accent-red/40 bg-accent-red-bg text-accent-red hover:bg-accent-red-bg/80 transition`}
        title={error ?? ""}
      >
        <span aria-hidden>↻</span> Retry
      </button>
      {error && (
        <span className="text-xs text-ink-dim truncate max-w-[220px]" title={error}>
          {error.length > 60 ? error.slice(0, 57) + "…" : error}
        </span>
      )}
    </div>
  );
}
