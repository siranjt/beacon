"use client";

import { useState } from "react";

/**
 * F-call-outcome — UI for marking + displaying a customer's latest call
 * outcome.
 *
 * Two modes:
 *   1. No active outcome → 3 inline buttons (Connected / VM / Not connected)
 *   2. Active outcome    → colored pill with countdown + dropdown to re-mark
 *
 * Connected = green (semantic success); VM = blue (info); Not connected =
 * red (danger). Colors match the missed-payments report convention.
 *
 * POST /api/v2/customer/<entityId>/call-outcome with body `{outcome}`.
 * On 200 the parent's onChange callback fires with the new outcome row so
 * the snapshot view can re-render without a full refetch.
 */

export type CallOutcomeKind = "connected" | "vm" | "not_connected";

export type CallOutcomeRow = {
  outcome: CallOutcomeKind;
  marked_at: string;
  marked_by_email: string;
  marked_by_name: string | null;
  expires_at: string;
};

type Props = {
  entityId: string;
  outcome?: CallOutcomeRow | null;
  onChange?: (next: CallOutcomeRow | null) => void;
};

const KIND_LABEL: Record<CallOutcomeKind, string> = {
  connected: "Connected",
  vm: "VM",
  not_connected: "Not connected",
};

// Watchfire-compatible semantic ramps — green for connected (success), blue
// for VM (info-style), red for not connected (danger). Pill bg ~10-18%
// alpha so it reads on the parchment card surface.
const KIND_PILL_STYLE: Record<CallOutcomeKind, { bg: string; color: string; border: string; chip: string }> = {
  connected: {
    bg: "rgba(99, 153, 34, 0.15)",
    color: "#173404",
    border: "rgba(99, 153, 34, 0.5)",
    chip: "✓",
  },
  vm: {
    bg: "rgba(55, 138, 221, 0.15)",
    color: "#042C53",
    border: "rgba(55, 138, 221, 0.5)",
    chip: "✉",
  },
  not_connected: {
    bg: "rgba(163, 45, 45, 0.15)",
    color: "#501313",
    border: "rgba(163, 45, 45, 0.5)",
    chip: "✕",
  },
};

const BUTTON_STYLE: Record<CallOutcomeKind, string> = {
  connected:
    "border-emerald-700/40 bg-emerald-700/10 text-emerald-900 hover:bg-emerald-700/20",
  vm:
    "border-sky-700/40 bg-sky-700/10 text-sky-900 hover:bg-sky-700/20",
  not_connected:
    "border-rose-700/40 bg-rose-700/10 text-rose-900 hover:bg-rose-700/20",
};

function formatRemaining(expiresIso: string): string {
  const ms = Date.parse(expiresIso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const totalH = Math.floor(ms / (60 * 60 * 1000));
  const days = Math.floor(totalH / 24);
  const hrs = totalH % 24;
  if (days >= 1) return `${days}d ${hrs}h left`;
  if (hrs >= 1) return `${hrs}h left`;
  const mins = Math.max(1, Math.floor(ms / (60 * 1000)));
  return `${mins}m left`;
}

export default function CallOutcomeControls({ entityId, outcome, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reMarkOpen, setReMarkOpen] = useState(false);

  async function mark(kind: CallOutcomeKind) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v2/customer/${entityId}/call-outcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: kind }),
      });
      const json = (await res.json()) as { ok?: boolean; outcome?: CallOutcomeRow; error?: string };
      if (!res.ok || !json.ok || !json.outcome) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      onChange?.(json.outcome);
      setReMarkOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clearOutcome() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v2/customer/${entityId}/call-outcome`, {
        method: "DELETE",
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      onChange?.(null);
      setReMarkOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ----- Active outcome: render the pill -----
  if (outcome) {
    const style = KIND_PILL_STYLE[outcome.outcome];
    return (
      <div className="flex flex-col items-end gap-1 text-right">
        <span
          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold"
          style={{ background: style.bg, color: style.color, borderColor: style.border }}
          aria-label={`Call outcome: ${KIND_LABEL[outcome.outcome]}`}
        >
          <span aria-hidden="true">{style.chip}</span>
          {KIND_LABEL[outcome.outcome]}
        </span>
        <div className="text-[10px] text-zoca-text-3 leading-snug">
          {formatRemaining(outcome.expires_at)}
          {outcome.marked_by_name && (
            <>
              {" "}· by {outcome.marked_by_name}
            </>
          )}
        </div>
        <div className="relative">
          <button
            type="button"
            disabled={busy}
            onClick={() => setReMarkOpen((v) => !v)}
            className="text-[10px] text-zoca-text-2 underline-offset-2 hover:text-amber-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
            aria-haspopup="true"
            aria-expanded={reMarkOpen}
          >
            Re-mark ▾
          </button>
          {reMarkOpen && (
            <div
              className="absolute right-0 z-10 mt-1 flex min-w-[160px] flex-col gap-1 rounded-zoca-md border border-zoca-text-3/20 bg-zoca-parchment p-1 shadow-md"
              role="menu"
            >
              {(["connected", "vm", "not_connected"] as CallOutcomeKind[])
                .filter((k) => k !== outcome.outcome)
                .map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => mark(k)}
                    className={`rounded-zoca-sm border px-2 py-1 text-left text-xs font-medium ${BUTTON_STYLE[k]}`}
                  >
                    Mark as {KIND_LABEL[k]}
                  </button>
                ))}
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={clearOutcome}
                className="rounded-zoca-sm border border-zoca-text-3/30 px-2 py-1 text-left text-xs text-zoca-text-2 hover:bg-zoca-text-3/10"
              >
                Clear outcome
              </button>
            </div>
          )}
        </div>
        {error && (
          <div role="alert" className="text-[10px] text-zoca-pink-bright">
            Couldn’t save: {error}
          </div>
        )}
      </div>
    );
  }

  // ----- No outcome: render the 3-button row -----
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5 flex-wrap justify-end" role="group" aria-label="Mark call outcome">
        <span className="text-[10px] text-zoca-text-3 mr-1">Call outcome:</span>
        {(["connected", "vm", "not_connected"] as CallOutcomeKind[]).map((k) => (
          <button
            key={k}
            type="button"
            disabled={busy}
            onClick={() => mark(k)}
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-50 ${BUTTON_STYLE[k]}`}
            title={`Mark this customer as ${KIND_LABEL[k]} — pill lives for 7 days`}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {error && (
        <div role="alert" className="text-[10px] text-zoca-pink-bright">
          Couldn’t save: {error}
        </div>
      )}
    </div>
  );
}
