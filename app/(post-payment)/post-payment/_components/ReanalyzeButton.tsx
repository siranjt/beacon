"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-analyze button for the single report page.
 *
 * Fires POST /post-payment/api/analyze/[customer_id]?force=true and surfaces
 * the queued/running state inline. Auth piggybacks on the NextAuth session
 * cookie (sent automatically on same-origin requests).
 *
 * UX sequence:
 *   1. Idle:     "↻ Re-analyze" button
 *   2. Confirm:  shows inline confirm strip ("Run again? ~2-5 min · overwrites current report")
 *   3. Queuing:  spinner + "Queuing…"
 *   4. Queued:   green success strip + countdown link "Refresh in N min" (auto-reloads)
 *   5. Error:    red strip with message + Retry button
 *
 * Why no full modal: the existing DocxPreviewButton uses a modal; we want the
 * Re-analyze action to feel lightweight (one click + one confirm), not a
 * heavyweight dialog. The inline confirm matches the button's visual rhythm
 * and the action is already destructive-soft (overwrites, doesn't delete).
 */
export function ReanalyzeButton({
  customerId,
  bizName,
  currentStatus,
}: {
  customerId: string;
  bizName?: string | null;
  currentStatus?: string | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "confirm" | "queuing" | "queued" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number>(180); // 3 min default refresh wait
  // Which model the in-flight / completed call used — drives the success
  // strip label so users know whether their Opus override was honored. null
  // means "default" (whatever ANTHROPIC_MODEL says, typically Sonnet).
  const [usedModel, setUsedModel] = useState<string | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-refresh countdown after successful queue
  useEffect(() => {
    if (phase !== "queued") return;
    tickRef.current = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) {
          if (tickRef.current) clearInterval(tickRef.current);
          // Pull a fresh server render so verdict/key facts update
          router.refresh();
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [phase, router]);

  async function trigger(modelOverride?: "opus" | "sonnet" | "haiku") {
    setPhase("queuing");
    setError(null);
    setUsedModel(modelOverride ?? null);
    try {
      const qs = new URLSearchParams({ force: "true" });
      if (modelOverride) qs.set("model", modelOverride);
      const res = await fetch(
        `/post-payment/api/analyze/${customerId}?${qs.toString()}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      if (body?.skipped) {
        // Shouldn't happen with force=true, but guard anyway
        throw new Error(body?.reason ?? "request skipped");
      }
      // Opus is ~2-3× slower than Sonnet — extend the auto-refresh countdown
      // when the user explicitly opted into it so they don't hit "Refresh now"
      // before the pipeline has had time to complete.
      setCountdown(modelOverride === "opus" ? 360 : 180);
      setPhase("queued");
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setPhase("error");
    }
  }

  // ── PHASE: queued (success) ──────────────────────────────────────────────
  if (phase === "queued") {
    const mins = Math.floor(countdown / 60);
    const secs = countdown % 60;
    const stamp = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    return (
      <div
        role="status"
        aria-live="polite"
        className="anim-rise"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 12px",
          borderRadius: 8,
          border: "1px solid rgba(74, 124, 89, 0.4)", // patina @ 40%
          background: "rgba(74, 124, 89, 0.12)",
          color: "#2B1F14",
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        <span style={{ color: "#4A7C59" }}>✓</span>
        <span>
          Queued{usedModel ? ` (${usedModel})` : ""} — analysis running in background. Auto-refreshing in{" "}
          <strong style={{ fontVariantNumeric: "tabular-nums" }}>{stamp}</strong>
        </span>
        <button
          onClick={() => router.refresh()}
          style={{
            marginLeft: 4,
            padding: "2px 8px",
            background: "transparent",
            border: "1px solid rgba(43, 31, 20, 0.2)",
            borderRadius: 6,
            color: "#2B1F14",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Refresh now
        </button>
      </div>
    );
  }

  // ── PHASE: error ─────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <div
        role="alert"
        className="anim-rise"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 12px",
          borderRadius: 8,
          border: "1px solid rgba(200, 67, 29, 0.4)", // ember @ 40%
          background: "rgba(200, 67, 29, 0.12)",
          color: "#2B1F14",
          fontSize: 13,
          fontWeight: 500,
          maxWidth: 420,
        }}
      >
        <span style={{ color: "#C8431D" }}>✕</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={error ?? ""}>
          Failed: {error ?? "unknown error"}
        </span>
        <button
          onClick={() => setPhase("idle")}
          style={{
            marginLeft: 4,
            padding: "2px 8px",
            background: "transparent",
            border: "1px solid rgba(43, 31, 20, 0.2)",
            borderRadius: 6,
            color: "#2B1F14",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  // ── PHASE: queuing (in-flight) ───────────────────────────────────────────
  if (phase === "queuing") {
    return (
      <button
        disabled
        className="px-3 py-1.5 border border-line rounded-lg"
        style={{
          color: "#7B6B57",
          background: "rgba(43, 31, 20, 0.04)",
          cursor: "wait",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontSize: 14,
        }}
      >
        <span
          className="animate-spin"
          style={{
            display: "inline-block",
            width: 12,
            height: 12,
            borderRadius: "50%",
            border: "2px solid rgba(43, 31, 20, 0.2)",
            borderTopColor: "#C8431D",
          }}
        />
        Queuing…
      </button>
    );
  }

  // ── PHASE: confirm (inline) ──────────────────────────────────────────────
  if (phase === "confirm") {
    return (
      <div
        className="anim-rise"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px 4px 12px",
          borderRadius: 8,
          border: "1px solid rgba(217, 164, 65, 0.45)", // brass
          background: "rgba(217, 164, 65, 0.10)",
          color: "#2B1F14",
          fontSize: 13,
          flexWrap: "wrap",
        }}
      >
        <span>
          Re-run analysis? <span style={{ color: "#7B6B57" }}>overwrites current report</span>
        </span>
        {/*
          Two paths: default model (env, typically Sonnet — fast/cheap) and
          Opus override (~2-3× slower, ~10× more expensive, sharper on the
          qualitative Section 5 / qualitative_flags reads). See anthropic.ts
          for the model selection details.
        */}
        <button
          onClick={() => trigger()}
          title="Use the production default model (typically Sonnet — ~90–150s)"
          style={{
            padding: "4px 12px",
            background: "#C8431D",
            color: "#F0E4CC",
            border: 0,
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Yes, re-run
        </button>
        <button
          onClick={() => trigger("opus")}
          title="Use Opus 4.6 — sharper qualitative reads, but ~3–5 min and ~10× cost. For high-stakes edge cases."
          style={{
            padding: "4px 12px",
            background: "transparent",
            border: "1px solid #C8431D",
            borderRadius: 6,
            color: "#C8431D",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Use Opus
        </button>
        <button
          onClick={() => setPhase("idle")}
          style={{
            padding: "4px 10px",
            background: "transparent",
            border: "1px solid rgba(43, 31, 20, 0.2)",
            borderRadius: 6,
            color: "#2B1F14",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  // ── PHASE: idle (default) ────────────────────────────────────────────────
  return (
    <button
      onClick={() => setPhase("confirm")}
      title={
        currentStatus === "processing"
          ? "A pipeline is currently running. Forcing re-run will overwrite it once complete."
          : `Force a fresh LLM analysis${bizName ? ` for ${bizName}` : ""}.`
      }
      className="btn-bounce px-3 py-1.5 border border-line text-ink-muted rounded-lg hover:bg-elevated hover:border-accent-blue transition"
      style={{ fontSize: 14, cursor: "pointer", whiteSpace: "nowrap" }}
    >
      ↻ Re-analyze
    </button>
  );
}
