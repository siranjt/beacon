"use client";

/**
 * ActionCard — inline approval card for a Beacon AI tool_use. Phase E-16 Wave 1.
 *
 * Beacon AI proposes a mutation via a `tool_use` content block; we render
 * this card inside the AskPanel transcript instead of plain text. The AM
 * can Approve (POSTs to /api/ai/action/execute) or Discard (PUTs the same
 * endpoint so it's audited). After the choice resolves, the card collapses
 * into a one-line trailer and the parent feeds the result back to Claude
 * via a tool_result message — so the conversation can continue naturally.
 *
 * One card == one tool_use_id. Approve/Discard buttons disable once a final
 * status has been reached. We rely on the parent AskPanel for streaming-
 * continuation; this component is purely presentational + does the
 * Approve/Discard POST.
 */

import { useCallback, useState } from "react";

const SANS = "-apple-system, Inter, system-ui, sans-serif";
const SERIF = 'Georgia, "Times New Roman", serif';

const C = {
  text: "var(--zoca-text)",
  text2: "var(--zoca-text-2)",
  text3: "var(--zoca-text-3)",
  surface: "#F8EFD7",
  parchment: "#F0E4CC",
  border: "#D4C29B",
  ember: "#C8431D",
  brass: "#D9A441",
  patina: "#4A7C59",
  char: "#2B1F14",
};

export type ActionCardStatus =
  | "pending"
  | "approving"
  | "approved"
  | "discarded"
  | "error";

export interface ActionCardData {
  /** Anthropic-assigned id of the proposed tool_use block. */
  toolUseId: string;
  /** Stable tool name from the registry. */
  toolName: string;
  /** Raw input the model produced (unknown shape until validated server-side). */
  input: Record<string, unknown>;
  /** Entity id this action targets. */
  customerId: string;
  /** Display name for the customer ("Acme Salon" or fallback to id). */
  customerName: string;
}

interface Props {
  data: ActionCardData;
  status: ActionCardStatus;
  /** Final summary surfaced on success. */
  resultSummary?: string | null;
  /** Final error surfaced on failure. */
  resultError?: string | null;
  /** Parent handles approval — posts to /execute and threads tool_result back. */
  onApprove: () => void;
  /** Parent handles discard — PUTs to /execute audit endpoint + threads tool_result. */
  onDiscard: () => void;
}

const VERBS: Record<string, string> = {
  snooze_customer: "Snooze",
  pin_customer: "Pin / Unpin",
  mark_contacted_today: "Mark contacted",
  add_note: "Add note to",
};

function verbFor(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "pin_customer") {
    return input.pin === false ? "Unpin" : "Pin";
  }
  return VERBS[toolName] ?? toolName;
}

function describeParams(toolName: string, input: Record<string, unknown>): React.ReactNode {
  switch (toolName) {
    case "snooze_customer": {
      const days = typeof input.days === "number" ? input.days : Number(input.days);
      const reason = typeof input.reason === "string" ? input.reason : null;
      return (
        <>
          <Row label="Duration" value={`${days} day${days === 1 ? "" : "s"}`} />
          {reason && <Row label="Reason" value={reason} />}
        </>
      );
    }
    case "pin_customer": {
      return <Row label="Pin state" value={input.pin === true ? "Pinned" : "Unpinned"} />;
    }
    case "mark_contacted_today": {
      const channel = String(input.channel ?? "");
      const summary = typeof input.summary === "string" ? input.summary : null;
      return (
        <>
          <Row label="Channel" value={channel} />
          {summary && <Row label="Summary" value={summary} />}
        </>
      );
    }
    case "add_note": {
      const body = typeof input.body === "string" ? input.body : "";
      const preview = body.length > 240 ? `${body.slice(0, 237)}…` : body;
      return <Row label="Note" value={preview} multiline />;
    }
    default:
      return (
        <Row
          label="Args"
          value={JSON.stringify(input, null, 2)}
          multiline
        />
      );
  }
}

function Row({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "84px 1fr",
        gap: 8,
        fontSize: 12,
        lineHeight: 1.5,
        color: C.text2,
        padding: "2px 0",
      }}
    >
      <span style={{ color: C.text3, fontFamily: SANS }}>{label}</span>
      <span
        style={{
          color: C.text,
          fontFamily: SANS,
          whiteSpace: multiline ? "pre-wrap" : "normal",
          wordBreak: multiline ? "break-word" : "normal",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export default function ActionCard({
  data,
  status,
  resultSummary,
  resultError,
  onApprove,
  onDiscard,
}: Props) {
  const [pressed, setPressed] = useState<"approve" | "discard" | null>(null);

  const handleApprove = useCallback(() => {
    if (status !== "pending") return;
    setPressed("approve");
    onApprove();
  }, [onApprove, status]);

  const handleDiscard = useCallback(() => {
    if (status !== "pending") return;
    setPressed("discard");
    onDiscard();
  }, [onDiscard, status]);

  // Once approved or discarded, collapse into a slim trailer line that
  // matches the read-only feel of the rest of the transcript.
  if (status === "approved") {
    return (
      <div
        style={{
          alignSelf: "flex-start",
          maxWidth: "92%",
          padding: "6px 10px",
          fontSize: 12,
          color: C.patina,
          fontFamily: SANS,
          background: "rgba(74, 124, 89, 0.08)",
          border: `1px solid ${C.patina}`,
          borderRadius: 8,
        }}
      >
        <strong style={{ marginRight: 6 }}>✓</strong>
        {resultSummary ?? `${verbFor(data.toolName, data.input)} ${data.customerName}.`}
      </div>
    );
  }
  if (status === "discarded") {
    return (
      <div
        style={{
          alignSelf: "flex-start",
          maxWidth: "92%",
          padding: "6px 10px",
          fontSize: 12,
          color: C.text3,
          fontFamily: SANS,
          background: "rgba(43, 31, 20, 0.04)",
          border: `1px solid ${C.border}`,
          borderRadius: 8,
        }}
      >
        <strong style={{ marginRight: 6 }}>✗</strong>
        Skipped — {verbFor(data.toolName, data.input)} {data.customerName}.
      </div>
    );
  }
  if (status === "error") {
    return (
      <div
        style={{
          alignSelf: "flex-start",
          maxWidth: "92%",
          padding: "8px 12px",
          fontSize: 12,
          color: C.ember,
          fontFamily: SANS,
          background: "rgba(200, 67, 29, 0.06)",
          border: `1px solid ${C.ember}`,
          borderRadius: 8,
        }}
      >
        <strong style={{ marginRight: 6 }}>Couldn't run action.</strong>
        {resultError ?? "Unknown error"}
      </div>
    );
  }

  const verb = verbFor(data.toolName, data.input);
  const isApproving = status === "approving" || pressed === "approve";

  return (
    <div
      style={{
        alignSelf: "flex-start",
        maxWidth: "94%",
        background: C.parchment,
        border: `1px solid ${C.brass}`,
        borderLeft: `3px solid ${C.brass}`,
        borderRadius: 12,
        padding: "12px 14px",
        fontFamily: SANS,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div
          style={{
            fontFamily: SERIF,
            fontSize: 14,
            fontWeight: 500,
            color: C.text,
          }}
        >
          {verb} <em style={{ color: C.text2 }}>{data.customerName}</em>
        </div>
        <span
          style={{
            fontSize: 10,
            color: C.text3,
            fontFamily: "ui-monospace, monospace",
            background: "rgba(43, 31, 20, 0.04)",
            border: `1px solid ${C.border}`,
            padding: "1px 6px",
            borderRadius: 999,
          }}
          title="Beacon AI–proposed action"
        >
          Beacon AI proposes
        </span>
      </div>

      <div style={{ marginBottom: 10 }}>{describeParams(data.toolName, data.input)}</div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={handleDiscard}
          disabled={status !== "pending"}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            fontFamily: SANS,
            border: `1px solid ${C.border}`,
            background: "transparent",
            color: C.text2,
            borderRadius: 8,
            cursor: status === "pending" ? "pointer" : "not-allowed",
          }}
        >
          Discard
        </button>
        <button
          type="button"
          onClick={handleApprove}
          disabled={status !== "pending"}
          style={{
            padding: "6px 14px",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: SANS,
            border: `1px solid ${C.char}`,
            background: status === "pending" ? C.char : C.border,
            color: C.parchment,
            borderRadius: 8,
            cursor: status === "pending" ? "pointer" : "not-allowed",
          }}
        >
          {isApproving ? "Running…" : "Approve"}
        </button>
      </div>
    </div>
  );
}
