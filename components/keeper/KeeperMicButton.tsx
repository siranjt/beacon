"use client";

/**
 * KeeperMicButton — Wave C voice-teach surface for V2BrainPanel.
 *
 * Why: ships the "talk to teach Keeper a fact" flow next to the Keeper
 * panel header. Click → starts browser STT → speak a sentence → click again
 * → server extract → confirm card → write.
 *
 * Why bound to ONE customer: the panel renders for a SPECIFIC entityId,
 * so the mic always knows who the fact targets. No ambiguity, no scope
 * drift, no "wait which customer were you talking about" UX failures.
 *
 * Visual: brass body matching KeeperChip palette, ember dot when live.
 * Pulse animation honors prefers-reduced-motion. Layout sits inline-flex
 * with the KeeperChip + collapse toggle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import KeeperVault from "./KeeperVault";
import useVoiceTranscript from "@/hooks/useVoiceTranscript";
import { categoryForSubcategory, FIELD_CATALOG } from "@/lib/brain/types";
import type {
  TopicCategory,
  TopicSubcategory,
} from "@/lib/brain/types";

interface Props {
  /** Entity ID (UUID) of the customer this panel renders for. */
  entityId: string;
  /** Chargebee customer_id when known — used for the activity log only. */
  customerId?: string | null;
  /** Bizname for the confirm card heading. */
  bizname?: string | null;
  /** Fires when a confirm POST returns ok=true so the parent can refetch. */
  onSaved?: () => void;
}

interface DraftFact {
  topic_category: TopicCategory;
  topic_subcategory: TopicSubcategory;
  field_name: string;
  value: string;
  confidence: "high" | "medium" | "low";
}

interface ExtractResponse {
  ok: boolean;
  unparseable?: boolean;
  reason?: string;
  bizname?: string | null;
  draft?: DraftFact;
  error?: string;
}

interface ConfirmResponse {
  ok: boolean;
  error?: string;
  conflict?: {
    conflicting_value: string;
    similarity: number;
  };
  fact?: { fact_id: string };
}

type Phase =
  | "idle"
  | "listening"
  | "extracting"
  | "draft"
  | "writing"
  | "error";

const PALETTE = {
  brass: "#D9A441",
  ember: "#C8431D",
  brassBg: "rgba(217, 164, 65, 0.14)",
  brassBorder: "rgba(217, 164, 65, 0.4)",
  emberBg: "rgba(200, 67, 29, 0.12)",
  emberBorder: "rgba(200, 67, 29, 0.35)",
  text: "#3a2f1d",
  parchment: "#fdf9ee",
  border: "#d8c9a8",
};

export default function KeeperMicButton({
  entityId,
  bizname,
  onSaved,
}: Props) {
  const voice = useVoiceTranscript();
  const [phase, setPhase] = useState<Phase>("idle");
  const [draft, setDraft] = useState<DraftFact | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editSubcategory, setEditSubcategory] =
    useState<TopicSubcategory | "">("");
  const [editFieldName, setEditFieldName] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showCard, setShowCard] = useState(false);
  const finishingRef = useRef(false);

  // When voice stops AND we previously kicked off listening, send to /extract.
  useEffect(() => {
    if (finishingRef.current && !voice.isListening) {
      finishingRef.current = false;
      const transcript = voice.transcript.trim();
      if (!transcript) {
        setPhase("idle");
        return;
      }
      setPhase("extracting");
      void fetch("/api/keeper/voice-extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript, entity_id: entityId }),
      })
        .then((r) => r.json() as Promise<ExtractResponse>)
        .then((json) => {
          if (!json.ok) {
            setErrorMsg(json.error || "Voice extract failed");
            setPhase("error");
            setShowCard(true);
            return;
          }
          if (json.unparseable || !json.draft) {
            setErrorMsg(
              json.reason
                ? `Couldn't pull a fact out of that (${json.reason}). Try again with one short sentence.`
                : "Couldn't pull a fact out of that. Try one short sentence.",
            );
            setPhase("error");
            setShowCard(true);
            return;
          }
          setDraft(json.draft);
          setEditValue(json.draft.value);
          setEditSubcategory(json.draft.topic_subcategory);
          setEditFieldName(json.draft.field_name);
          setPhase("draft");
          setShowCard(true);
        })
        .catch((e: unknown) => {
          setErrorMsg(e instanceof Error ? e.message : String(e));
          setPhase("error");
          setShowCard(true);
        });
    }
  }, [voice.isListening, voice.transcript, entityId]);

  const handleClick = useCallback(() => {
    if (phase === "listening") {
      finishingRef.current = true;
      voice.stop();
      return;
    }
    if (phase === "extracting" || phase === "writing") return;
    if (!voice.supported) {
      setErrorMsg(
        "Voice teach needs Chrome, Safari, or Edge — Firefox doesn't ship the SpeechRecognition API.",
      );
      setPhase("error");
      setShowCard(true);
      return;
    }
    setErrorMsg(null);
    setDraft(null);
    setShowCard(false);
    voice.reset();
    voice.start();
    setPhase("listening");
  }, [phase, voice]);

  const handleConfirm = useCallback(
    (force: boolean) => {
      if (!draft || !editSubcategory) return;
      const expectedCategory = categoryForSubcategory(editSubcategory);
      setPhase("writing");
      setErrorMsg(null);
      void fetch("/api/keeper/voice-extract/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId,
          topic_category: expectedCategory,
          topic_subcategory: editSubcategory,
          field_name: editFieldName || "other",
          value: editValue.trim(),
          force,
        }),
      })
        .then((r) =>
          r.json().then((body: ConfirmResponse) => ({ status: r.status, body })),
        )
        .then(({ status, body }) => {
          if (!body.ok) {
            if (status === 409 && body.conflict) {
              setErrorMsg(body.error || "Near-duplicate detected.");
              setPhase("draft");
              return;
            }
            setErrorMsg(body.error || "Failed to save.");
            setPhase("error");
            return;
          }
          setShowCard(false);
          setDraft(null);
          setPhase("idle");
          onSaved?.();
        })
        .catch((e: unknown) => {
          setErrorMsg(e instanceof Error ? e.message : String(e));
          setPhase("error");
        });
    },
    [draft, editSubcategory, editFieldName, editValue, entityId, onSaved],
  );

  const handleCancel = useCallback(() => {
    setShowCard(false);
    setDraft(null);
    setErrorMsg(null);
    setPhase("idle");
  }, []);

  const isLive = phase === "listening" || voice.isListening;
  const isBusy = phase === "extracting" || phase === "writing";

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={handleClick}
        disabled={isBusy}
        title={
          isLive
            ? "Listening… click to stop"
            : "Teach Keeper a fact"
        }
        aria-label="Teach Keeper a fact"
        aria-pressed={isLive}
        className="keeper-mic-btn"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          padding: "4px 10px",
          borderRadius: 999,
          background: isLive ? PALETTE.emberBg : PALETTE.brassBg,
          color: isLive ? "#8b3416" : "#8a6014",
          border: `0.5px solid ${
            isLive ? PALETTE.emberBorder : PALETTE.brassBorder
          }`,
          fontFamily: "-apple-system, Inter, system-ui, sans-serif",
          fontWeight: 500,
          cursor: isBusy ? "not-allowed" : "pointer",
          lineHeight: 1,
          opacity: isBusy ? 0.7 : 1,
          verticalAlign: "1px",
        }}
      >
        <KeeperVault size={14} />
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: 999,
            background: isLive ? PALETTE.ember : PALETTE.brass,
            animation: isLive ? "kmb-pulse 1.2s ease-in-out infinite" : "none",
          }}
        />
        <span>
          {isLive
            ? "Listening…"
            : phase === "extracting"
              ? "Extracting…"
              : phase === "writing"
                ? "Saving…"
                : "Teach"}
        </span>
      </button>
      <style jsx>{`
        @keyframes kmb-pulse {
          0%,
          100% {
            transform: scale(1);
            opacity: 1;
          }
          50% {
            transform: scale(1.4);
            opacity: 0.6;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .keeper-mic-btn span[aria-hidden] {
            animation: none !important;
          }
        }
      `}</style>

      {showCard && (
        <VoiceFactCard
          phase={phase}
          bizname={bizname ?? null}
          draft={draft}
          editValue={editValue}
          editSubcategory={editSubcategory}
          editFieldName={editFieldName}
          errorMsg={errorMsg}
          onChangeValue={setEditValue}
          onChangeSubcategory={(s) => {
            setEditSubcategory(s);
            // When subcategory changes, snap to "other" to avoid invalid
            // pairings until the user picks a valid named field.
            setEditFieldName("other");
          }}
          onChangeFieldName={setEditFieldName}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </span>
  );
}

/**
 * Confirm card — popover anchored under the mic button. Reused by
 * BeamMicButton via the same prop shape but rendered standalone here so
 * V2BrainPanel doesn't need to know about voice flows.
 *
 * Editable: value, subcategory, field_name. Category is derived from
 * the subcategory (Keeper invariant) so it isn't editable in the UI.
 */
function VoiceFactCard({
  phase,
  bizname,
  draft,
  editValue,
  editSubcategory,
  editFieldName,
  errorMsg,
  onChangeValue,
  onChangeSubcategory,
  onChangeFieldName,
  onConfirm,
  onCancel,
}: {
  phase: Phase;
  bizname: string | null;
  draft: DraftFact | null;
  editValue: string;
  editSubcategory: TopicSubcategory | "";
  editFieldName: string;
  errorMsg: string | null;
  onChangeValue: (v: string) => void;
  onChangeSubcategory: (s: TopicSubcategory) => void;
  onChangeFieldName: (f: string) => void;
  onConfirm: (force: boolean) => void;
  onCancel: () => void;
}) {
  const subcategoryOptions = Object.keys(FIELD_CATALOG) as TopicSubcategory[];
  const namedFields =
    editSubcategory && editSubcategory in FIELD_CATALOG
      ? FIELD_CATALOG[editSubcategory].named_fields
      : [];

  const canConfirm =
    !!draft &&
    !!editSubcategory &&
    editValue.trim().length > 0 &&
    phase !== "writing";
  const isConflict =
    !!errorMsg && errorMsg.toLowerCase().includes("near-duplicate");

  return (
    <div
      role="dialog"
      aria-label="Confirm Keeper fact"
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        right: 0,
        zIndex: 50,
        width: 360,
        background: PALETTE.parchment,
        border: `1px solid ${PALETTE.border}`,
        borderRadius: 10,
        padding: 12,
        boxShadow: "0 6px 20px rgba(0,0,0,0.12)",
        fontFamily: "-apple-system, Inter, system-ui, sans-serif",
        color: PALETTE.text,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "#8a6014",
          }}
        >
          <KeeperVault size={14} />
          Teach Keeper {bizname ? `· ${bizname}` : ""}
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          style={{
            background: "transparent",
            border: "none",
            color: PALETTE.text,
            fontSize: 14,
            cursor: "pointer",
            padding: 0,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {phase === "error" && !draft ? (
        <div
          style={{
            fontSize: 12,
            color: "#8b3416",
            marginBottom: 8,
          }}
        >
          {errorMsg ?? "Something went wrong."}
        </div>
      ) : null}

      {draft && (
        <>
          <label
            style={{
              display: "block",
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "#7a6a40",
              marginTop: 6,
              marginBottom: 3,
            }}
          >
            Subcategory
          </label>
          <select
            value={editSubcategory}
            onChange={(e) =>
              onChangeSubcategory(e.target.value as TopicSubcategory)
            }
            style={selectStyle}
          >
            {subcategoryOptions.map((s) => (
              <option key={s} value={s}>
                {FIELD_CATALOG[s].category} / {s}
              </option>
            ))}
          </select>

          <label
            style={{
              display: "block",
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "#7a6a40",
              marginTop: 8,
              marginBottom: 3,
            }}
          >
            Field
          </label>
          <select
            value={editFieldName}
            onChange={(e) => onChangeFieldName(e.target.value)}
            style={selectStyle}
          >
            {namedFields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            <option value="other">other</option>
          </select>

          <label
            style={{
              display: "block",
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "#7a6a40",
              marginTop: 8,
              marginBottom: 3,
            }}
          >
            Value
          </label>
          <textarea
            value={editValue}
            onChange={(e) => onChangeValue(e.target.value)}
            rows={3}
            style={{
              width: "100%",
              padding: "6px 8px",
              border: `1px solid ${PALETTE.border}`,
              borderRadius: 6,
              fontFamily: "inherit",
              fontSize: 12,
              color: PALETTE.text,
              background: "white",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />

          <div
            style={{
              marginTop: 6,
              fontSize: 10,
              color: "#7a6a40",
            }}
          >
            Confidence: {draft.confidence}
          </div>

          {errorMsg && (
            <div
              style={{
                marginTop: 8,
                padding: 6,
                borderRadius: 6,
                background: PALETTE.emberBg,
                border: `0.5px solid ${PALETTE.emberBorder}`,
                fontSize: 11,
                color: "#8b3416",
              }}
            >
              {errorMsg}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 6,
              marginTop: 10,
            }}
          >
            <button
              type="button"
              onClick={onCancel}
              style={ghostBtnStyle}
            >
              Cancel
            </button>
            {isConflict && (
              <button
                type="button"
                onClick={() => onConfirm(true)}
                disabled={!canConfirm}
                style={emberBtnStyle(!canConfirm)}
              >
                Save anyway
              </button>
            )}
            {!isConflict && (
              <button
                type="button"
                onClick={() => onConfirm(false)}
                disabled={!canConfirm}
                style={brassBtnStyle(!canConfirm)}
              >
                {phase === "writing" ? "Saving…" : "Save to Keeper"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "5px 8px",
  border: `1px solid ${PALETTE.border}`,
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 12,
  color: PALETTE.text,
  background: "white",
  boxSizing: "border-box",
};

const ghostBtnStyle: React.CSSProperties = {
  padding: "5px 10px",
  borderRadius: 6,
  border: `1px solid ${PALETTE.border}`,
  background: "transparent",
  color: PALETTE.text,
  fontFamily: "inherit",
  fontSize: 11,
  cursor: "pointer",
};

function brassBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "5px 12px",
    borderRadius: 6,
    border: `1px solid ${PALETTE.brass}`,
    background: disabled ? PALETTE.brassBg : PALETTE.brass,
    color: disabled ? PALETTE.text : "#fff",
    fontFamily: "inherit",
    fontSize: 11,
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function emberBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "5px 12px",
    borderRadius: 6,
    border: `1px solid ${PALETTE.ember}`,
    background: disabled ? PALETTE.emberBg : PALETTE.ember,
    color: disabled ? "#8b3416" : "#fff",
    fontFamily: "inherit",
    fontSize: 11,
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
