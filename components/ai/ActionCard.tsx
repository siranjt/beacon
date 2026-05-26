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
import ConfidenceBadge, {
  type ConfidenceData,
} from "@/components/ai/ConfidenceBadge";

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
  /**
   * Phase E-16 Wave 2 — the `data` field of the tool result envelope. For
   * draft tools this carries the rendered subject/body/recipient; for
   * lookup_customer it carries the matched hits. Wave 1 mutators leave this
   * undefined and the trailer pill is sufficient.
   */
  resultData?: Record<string, unknown> | null;
  /**
   * Phase E-17 Wave 3a — optional confidence data parsed from the
   * assistant's `<confidence: NN% — reasons>` marker. When present we render
   * a ConfidenceBadge at the top of the card so the AM can see Beacon AI's
   * read of the evidence before approving the action.
   */
  confidence?: ConfidenceData | null;
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
  lookup_customer: "Look up",
  draft_email_to_contact: "Draft email to",
  draft_slack_message: "Draft Slack message about",
};

function verbFor(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "pin_customer") {
    return input.pin === false ? "Unpin" : "Pin";
  }
  return VERBS[toolName] ?? toolName;
}

/**
 * Wave 2 — tools whose approved-state surface is more than a one-line trailer.
 * Drafts get a full preview + Copy buttons; lookup gets a hit list with
 * "use this" rows. The collapsed-trailer fallback still applies to the
 * Wave-1 mutators (snooze / pin / mark-contacted / add_note).
 */
function isRichResultTool(toolName: string): boolean {
  return (
    toolName === "draft_email_to_contact" ||
    toolName === "draft_slack_message" ||
    toolName === "lookup_customer"
  );
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
    case "lookup_customer": {
      const query = typeof input.query === "string" ? input.query : "";
      return <Row label="Query" value={query} />;
    }
    case "draft_email_to_contact": {
      const contactEmail =
        typeof input.contact_email === "string" ? input.contact_email : null;
      const subjectBrief =
        typeof input.subject_brief === "string" ? input.subject_brief : null;
      const bodyBrief =
        typeof input.body_brief === "string" ? input.body_brief : "";
      const bodyPreview =
        bodyBrief.length > 220 ? `${bodyBrief.slice(0, 217)}…` : bodyBrief;
      return (
        <>
          {contactEmail && <Row label="To" value={contactEmail} />}
          {subjectBrief && <Row label="Subject hint" value={subjectBrief} />}
          <Row label="Brief" value={bodyPreview} multiline />
        </>
      );
    }
    case "draft_slack_message": {
      const channelHint =
        typeof input.channel_hint === "string" ? input.channel_hint : null;
      const bodyBrief =
        typeof input.body_brief === "string" ? input.body_brief : "";
      const bodyPreview =
        bodyBrief.length > 220 ? `${bodyBrief.slice(0, 217)}…` : bodyBrief;
      return (
        <>
          {channelHint && <Row label="Channel" value={channelHint} />}
          <Row label="Brief" value={bodyPreview} multiline />
        </>
      );
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
  resultData,
  confidence,
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
  // matches the read-only feel of the rest of the transcript — EXCEPT for
  // the Wave 2 rich-result tools (drafts + lookup), which deserve a full
  // panel with copy buttons / hit list.
  if (status === "approved") {
    if (isRichResultTool(data.toolName) && resultData) {
      return (
        <RichResultPanel
          toolName={data.toolName}
          data={resultData}
          customerName={data.customerName}
        />
      );
    }
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

      {/* Phase E-17 Wave 3a — confidence badge surfaces the model's read of
          the evidence before the AM clicks Approve. */}
      {confidence && (
        <div style={{ marginBottom: 8 }}>
          <ConfidenceBadge data={confidence} variant="card" />
        </div>
      )}

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

/* ────────────────────────────────────────────────────────────────
 * Wave 2 — rich result panels
 *
 * After approval lands for one of the rich-result tools (draft_email,
 * draft_slack, lookup_customer), we render this panel in place of the
 * collapsed trailer. Watchfire palette throughout (parchment surface, char
 * text, ember accents on action buttons).
 * ──────────────────────────────────────────────────────────────── */

interface RichResultPanelProps {
  toolName: string;
  data: Record<string, unknown>;
  customerName: string;
}

function RichResultPanel({ toolName, data, customerName }: RichResultPanelProps) {
  if (toolName === "draft_email_to_contact") {
    return <DraftEmailResult data={data} customerName={customerName} />;
  }
  if (toolName === "draft_slack_message") {
    return <DraftSlackResult data={data} customerName={customerName} />;
  }
  if (toolName === "lookup_customer") {
    return <LookupResult data={data} />;
  }
  return null;
}

function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  }
  return Promise.resolve(false);
}

function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  }, [text]);
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "5px 10px",
        fontSize: 11,
        fontWeight: 600,
        fontFamily: SANS,
        border: `1px solid ${C.ember}`,
        background: copied ? C.ember : "transparent",
        color: copied ? C.parchment : C.ember,
        borderRadius: 6,
        cursor: "pointer",
        transition: "background 120ms ease, color 120ms ease",
      }}
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
}

/**
 * Build a `mailto:` URL with subject + body pre-filled. Browsers cap
 * mailto: at ~2000 chars on most platforms; we truncate to a safe 1800
 * including the prefix. This is documented as a v2.1 gap — long drafts
 * will be partially truncated in the Gmail compose window. The full draft
 * is still available via the Copy button.
 */
function mailtoUrl(args: {
  to: string;
  subject: string;
  body: string;
}): string {
  const MAX_TOTAL = 1800;
  const base = `mailto:${encodeURIComponent(args.to)}?subject=${encodeURIComponent(args.subject)}&body=`;
  const remaining = MAX_TOTAL - base.length;
  const encodedBody = encodeURIComponent(args.body);
  const safeBody =
    remaining > 0 && encodedBody.length > remaining
      ? encodedBody.slice(0, remaining)
      : encodedBody;
  return base + safeBody;
}

function DraftEmailResult({
  data,
  customerName,
}: {
  data: Record<string, unknown>;
  customerName: string;
}) {
  const subject = typeof data.subject === "string" ? data.subject : "";
  const body = typeof data.body === "string" ? data.body : "";
  const recipientEmail =
    typeof data.recipient_email === "string" ? data.recipient_email : "";
  const recipientName =
    typeof data.recipient_name === "string"
      ? data.recipient_name
      : "the recipient";
  const copyableText = `Subject: ${subject}\n\n${body}`;
  const gmailHref = mailtoUrl({ to: recipientEmail, subject, body });

  return (
    <div
      style={{
        alignSelf: "flex-start",
        width: "94%",
        maxWidth: "94%",
        background: C.parchment,
        border: `1px solid ${C.patina}`,
        borderLeft: `3px solid ${C.patina}`,
        borderRadius: 12,
        padding: "12px 14px",
        fontFamily: SANS,
      }}
    >
      <div
        style={{
          fontFamily: SERIF,
          fontSize: 14,
          fontWeight: 500,
          color: C.text,
          marginBottom: 4,
        }}
      >
        <span style={{ color: C.patina, marginRight: 6 }}>✓</span>
        Draft ready — {recipientName} at <em style={{ color: C.text2 }}>{customerName}</em>
      </div>
      <div
        style={{
          fontSize: 11,
          color: C.text3,
          fontFamily: "ui-monospace, monospace",
          marginBottom: 8,
          wordBreak: "break-all",
        }}
      >
        {recipientEmail || "(no email on file)"}
      </div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: C.text,
          marginBottom: 4,
        }}
      >
        Subject
      </div>
      <div
        style={{
          fontSize: 13,
          color: C.text,
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: "6px 10px",
          marginBottom: 10,
          fontFamily: SERIF,
        }}
      >
        {subject}
      </div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: C.text,
          marginBottom: 4,
        }}
      >
        Body
      </div>
      <div
        style={{
          fontSize: 12.5,
          lineHeight: 1.55,
          color: C.text,
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: "10px 12px",
          marginBottom: 10,
          fontFamily: SERIF,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 260,
          overflowY: "auto",
        }}
      >
        {body}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <CopyButton text={copyableText} label="Copy" />
        <a
          href={gmailHref}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: "5px 12px",
            fontSize: 11,
            fontWeight: 600,
            fontFamily: SANS,
            border: `1px solid ${C.char}`,
            background: C.char,
            color: C.parchment,
            borderRadius: 6,
            cursor: "pointer",
            textDecoration: "none",
          }}
        >
          Open in Gmail
        </a>
      </div>
    </div>
  );
}

function DraftSlackResult({
  data,
  customerName,
}: {
  data: Record<string, unknown>;
  customerName: string;
}) {
  const message = typeof data.message === "string" ? data.message : "";
  const channelHint =
    typeof data.channel_hint === "string" ? data.channel_hint : null;

  return (
    <div
      style={{
        alignSelf: "flex-start",
        width: "94%",
        maxWidth: "94%",
        background: C.parchment,
        border: `1px solid ${C.patina}`,
        borderLeft: `3px solid ${C.patina}`,
        borderRadius: 12,
        padding: "12px 14px",
        fontFamily: SANS,
      }}
    >
      <div
        style={{
          fontFamily: SERIF,
          fontSize: 14,
          fontWeight: 500,
          color: C.text,
          marginBottom: 4,
        }}
      >
        <span style={{ color: C.patina, marginRight: 6 }}>✓</span>
        Slack draft ready — about{" "}
        <em style={{ color: C.text2 }}>{customerName}</em>
      </div>
      {channelHint && (
        <div
          style={{
            fontSize: 11,
            color: C.text3,
            fontFamily: "ui-monospace, monospace",
            marginBottom: 8,
          }}
        >
          for {channelHint}
        </div>
      )}
      <div
        style={{
          fontSize: 12.5,
          lineHeight: 1.55,
          color: C.text,
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: "10px 12px",
          marginTop: channelHint ? 0 : 8,
          marginBottom: 10,
          fontFamily: SANS,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 220,
          overflowY: "auto",
        }}
      >
        {message}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <CopyButton text={message} label="Copy" />
      </div>
    </div>
  );
}

interface LookupHitForUI {
  entity_id: string;
  bizname: string | null;
  am_name: string | null;
  stoplight: "RED" | "YELLOW" | "GREEN" | null;
  composite_score: number | null;
  tier: string | null;
  last_contact_date: string | null;
}

function LookupResult({ data }: { data: Record<string, unknown> }) {
  const rawResults = Array.isArray(data.results) ? data.results : [];
  const hits = rawResults
    .filter(
      (r): r is Record<string, unknown> =>
        !!r && typeof r === "object" && !Array.isArray(r),
    )
    .map<LookupHitForUI>((r) => ({
      entity_id: typeof r.entity_id === "string" ? r.entity_id : "",
      bizname: typeof r.bizname === "string" ? r.bizname : null,
      am_name: typeof r.am_name === "string" ? r.am_name : null,
      stoplight:
        r.stoplight === "RED" || r.stoplight === "YELLOW" || r.stoplight === "GREEN"
          ? r.stoplight
          : null,
      composite_score:
        typeof r.composite_score === "number" ? r.composite_score : null,
      tier: typeof r.tier === "string" ? r.tier : null,
      last_contact_date:
        typeof r.last_contact_date === "string" ? r.last_contact_date : null,
    }));

  const query = typeof data.query === "string" ? data.query : "";

  if (hits.length === 0) {
    return (
      <div
        style={{
          alignSelf: "flex-start",
          maxWidth: "92%",
          padding: "8px 12px",
          fontSize: 12,
          color: C.text3,
          fontFamily: SANS,
          background: "rgba(43, 31, 20, 0.04)",
          border: `1px solid ${C.border}`,
          borderRadius: 8,
        }}
      >
        No customers matched <em>{query}</em>. Try a different query.
      </div>
    );
  }

  return (
    <div
      style={{
        alignSelf: "flex-start",
        width: "94%",
        maxWidth: "94%",
        background: C.parchment,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: "10px 12px",
        fontFamily: SANS,
      }}
    >
      <div
        style={{
          fontFamily: SERIF,
          fontSize: 13,
          color: C.text2,
          marginBottom: 6,
        }}
      >
        {hits.length} match{hits.length === 1 ? "" : "es"} for{" "}
        <em>{query}</em>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {hits.map((h) => (
          <LookupHitRow key={h.entity_id} hit={h} />
        ))}
      </div>
    </div>
  );
}

function stoplightColor(s: LookupHitForUI["stoplight"]): string {
  if (s === "RED") return C.ember;
  if (s === "YELLOW") return C.brass;
  if (s === "GREEN") return C.patina;
  return C.text3;
}

function LookupHitRow({ hit }: { hit: LookupHitForUI }) {
  const sendUseThis = useCallback(() => {
    // Surface the entity_id back to the AskPanel via the global "open"
    // event so the AM can act on it without typing the id by hand. The
    // panel listener already exists in AskPanel; we just dispatch a
    // pre-filled prompt referencing this customer.
    const label = hit.bizname ?? hit.entity_id;
    const prompt = `Use ${label} (entity_id ${hit.entity_id}) for the next action.`;
    window.dispatchEvent(
      new CustomEvent("beacon-ai:open", {
        detail: { prompt, autoSubmit: false },
      }),
    );
  }, [hit]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 8,
        padding: "6px 8px",
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        alignItems: "center",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: C.text,
            display: "flex",
            alignItems: "center",
            gap: 6,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: stoplightColor(hit.stoplight),
              flexShrink: 0,
            }}
          />
          {hit.bizname ?? hit.entity_id}
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: C.text3,
            fontFamily: "ui-monospace, monospace",
            marginTop: 2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {hit.am_name ? `${hit.am_name} · ` : ""}
          {hit.tier ? `${hit.tier} · ` : ""}
          {hit.composite_score !== null
            ? `composite ${hit.composite_score}`
            : "no score"}
        </div>
      </div>
      <button
        type="button"
        onClick={sendUseThis}
        style={{
          padding: "4px 10px",
          fontSize: 11,
          fontWeight: 600,
          fontFamily: SANS,
          border: `1px solid ${C.ember}`,
          background: "transparent",
          color: C.ember,
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        Use this
      </button>
    </div>
  );
}
