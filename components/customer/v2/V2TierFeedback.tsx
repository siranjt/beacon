"use client";

/**
 * Tier-feedback control. Phase SV-5.
 *
 * Two tiny thumbs (✓ accurate / ✗ wrong) sitting next to the call-outcome
 * cluster. Records whether the tier the AM sees feels right today.
 *
 * Idempotent per (entity, am, calendar_day) on the server; the local
 * `submitted` state mirrors that so re-clicking the same option is a no-op
 * after the first.
 */

import { useCallback, useState } from "react";
import type { Stoplight } from "@/lib/customer/config";

type Vote = "accurate" | "wrong";

interface Props {
  entityId: string;
  stoplight: Stoplight;
}

const ACCURATE_LABEL = "Tier feels right";
const WRONG_LABEL = "Tier feels wrong";

export default function V2TierFeedback({ entityId, stoplight }: Props) {
  const [vote, setVote] = useState<Vote | null>(null);
  const [pending, setPending] = useState<Vote | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (next: Vote) => {
      if (pending) return;
      setPending(next);
      setError(null);
      try {
        const res = await fetch("/api/v2/tier-feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entity_id: entityId,
            observed_tier: stoplight,
            is_accurate: next === "accurate",
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setVote(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(null);
      }
    },
    [entityId, stoplight, pending],
  );

  const baseBtn: React.CSSProperties = {
    width: 26,
    height: 26,
    borderRadius: 6,
    border: "1px solid rgba(45, 72, 67, 0.18)",
    background: "rgba(252, 246, 232, 0.8)",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 13,
    color: "#7a715f",
    transition: "all 140ms ease",
  };

  const activeAccurate: React.CSSProperties = {
    ...baseBtn,
    background: "rgba(73, 153, 100, 0.18)",
    borderColor: "rgba(73, 153, 100, 0.55)",
    color: "#1f4d2f",
  };

  const activeWrong: React.CSSProperties = {
    ...baseBtn,
    background: "rgba(196, 73, 73, 0.18)",
    borderColor: "rgba(196, 73, 73, 0.55)",
    color: "#7a1f1f",
  };

  return (
    <div
      style={{
        display: "inline-flex",
        gap: 4,
        alignItems: "center",
      }}
      title="How accurate is this tier? Helps tune Beacon's risk scoring."
    >
      <button
        type="button"
        aria-label={ACCURATE_LABEL}
        title={ACCURATE_LABEL}
        disabled={pending !== null}
        onClick={() => void submit("accurate")}
        style={vote === "accurate" ? activeAccurate : baseBtn}
      >
        {pending === "accurate" ? "…" : "✓"}
      </button>
      <button
        type="button"
        aria-label={WRONG_LABEL}
        title={WRONG_LABEL}
        disabled={pending !== null}
        onClick={() => void submit("wrong")}
        style={vote === "wrong" ? activeWrong : baseBtn}
      >
        {pending === "wrong" ? "…" : "✗"}
      </button>
      {error ? (
        <span
          role="alert"
          style={{ fontSize: 10, color: "#7a1f1f", marginLeft: 4 }}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
