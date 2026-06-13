"use client";

/**
 * BeamMicButton — Wave C voice-teach surface for the AskPanel composer.
 *
 * Why this exists separately from KeeperMicButton:
 *   - V2BrainPanel renders for ONE entity, so KeeperMicButton can hardcode
 *     `entityId` as a required prop.
 *   - AskPanel travels with the user across every scope — sometimes a
 *     specific customer is in scope (Customer 360, Performance Report), but
 *     usually it isn't (Customer Book, Inbox, Escalation, Miss Payment...).
 *     A voice-teach has to be customer-bound, so on whole-book scopes we
 *     DISABLE the button rather than guess. Tooltip explains.
 *
 * Behavior + visual treatment match KeeperMicButton 1:1 — same brass body,
 * same ember pulse, same SpeechRecognition hook, same confirm card UX, same
 * /api/keeper/voice-extract → /api/keeper/voice-extract/confirm path. The
 * only forks are (a) the disabled-tooltip branch and (b) the scope-derived
 * entityId resolution.
 *
 * Why no parallel write path: the confirm card POSTs to the same
 * voice-extract/confirm route that KeeperMicButton uses, which in turn calls
 * writeBrainFact with source_type='voice_teach'. Single write path, single
 * provenance tag, single Validate-inbox filter.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import KeeperVault from "@/components/keeper/KeeperVault";
import useVoiceTranscript from "@/hooks/useVoiceTranscript";
import { categoryForSubcategory, FIELD_CATALOG } from "@/lib/brain/types";
import type { TopicCategory, TopicSubcategory } from "@/lib/brain/types";
import type { AiScope } from "@/lib/ai/scopes";

interface Props {
  /**
   * Current AskPanel scope. We only enable the mic when the scope binds to
   * ONE customer (Customer 360 / Performance Report) so voice teach is
   * unambiguous. On whole-book scopes the button renders disabled with a
   * tooltip pointing the AM at the right surface.
   */
  scope: AiScope;
  /** Optional callback fired after a successful save. */
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
  muted: "rgba(110, 95, 80, 0.10)",
  mutedBorder: "rgba(110, 95, 80, 0.28)",
};

/**
 * Pull an entity_id out of the current scope when the scope is
 * customer-scoped. Returns null for whole-book scopes.
 */
function scopeEntityId(scope: AiScope): string | null {
  if (scope.kind === "customer-360") return scope.entityId;
  if (scope.kind === "performance-report") return scope.entityId;
  return null;
}

export default function BeamMicButton({ scope, onSaved }: Props) {
  const entityId = scopeEntityId(scope);
  const supportedScope = entityId !== null;

  const voice = useVoiceTranscript();
  const [phase, setPhase] = useState<Phase>("idle");
  const [draft, setDraft] = useState<DraftFact | null>(null);
  const [bizname, setBizname] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editSubcategory, setEditSubcategory] =
    useState<TopicSubcategory | "">("");
  const [editFieldName, setEditFieldName] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showCard, setShowCard] = useState(false);
  const finishingRef = useRef(false);

  // After voice.stop() flushes its final chunk, send transcript → extract.
  useEffect(() => {
    if (finishingRef.current && !voice.isListening) {
      finishingRef.current = false;
      const transcript = voice.transcript.trim();
      if (!transcript || !entityId) {
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
          setBizname(json.bizname ?? null);
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
    if (!supportedScope) return;
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
  }, [phase, supportedScope, voice]);

  const handleConfirm = useCallback(
    (force: boolean) => {
      if (!draft || !editSubcategory || !entityId) return;
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
  const disabled = !supportedScope || isBusy;

  const disabledTitle =
    "Pick a customer first to teach Keeper — open Customer 360 or a Performance Report.";
  const enabledTitle = isLive
    ? "Listening… click to stop"
    : "Teach Keeper a fact about this customer";

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        title={!supportedScope ? disabledTitle : enabledTitle}
        aria-label={
          !supportedScope ? disabledTitle : "Teach Keeper a fact about this customer"
        }
        aria-pressed={isLive}
        className="beam-mic-btn"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          padding: "5px 10px",
          borderRadius: 8,
          background: !supportedScope
            ? PALETTE.muted
            : isLive
              ? PALETTE.emberBg
              : PALETTE.brassBg,
          color: !supportedScope
            ? "#7a6a40"
            : isLive
              ? "#8b3416"
              : "#8a6014",
          border: `1px solid ${
            !supportedScope
              ? PALETTE.mutedBorder
              : isLive
                ? PALETTE.emberBorder
                : PALETTE.brassBorder
          }`,
          fontFamily: "inherit",
          fontWeight: 500,
          cursor: disabled ? "not-allowed" : "pointer",
          lineHeight: 1,
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <KeeperVault size={13} />
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 7,
            height: 7,
            borderRadius: 999,
            background: !supportedScope
              ? "rgba(110, 95, 80, 0.4)"
              : isLive
                ? PALETTE.ember
                : PALETTE.brass,
            animation: isLive ? "bmb-pulse 1.2s ease-in-out infinite" : "none",
          }}
        />
        <span>
          {!supportedScope
            ? "Teach"
            : isLive
              ? "Listening…"
              : phase === "extracting"
                ? "Extracting…"
                : phase === "writing"
                  ? "Saving…"
                  : "Teach"}
        </span>
      </button>
      <style jsx>{`
        @keyframes bmb-pulse {
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
          .beam-mic-btn span[aria-hidden] {
            animation: none !important;
          }
        }
      `}</style>

      {showCard && (
        <VoiceFactCard
          phase={phase}
          bizname={bizname}
          draft={draft}
          editValue={editValue}
          editSubcategory={editSubcategory}
          editFieldName={editFieldName}
          errorMsg={errorMsg}
          onChangeValue={setEditValue}
          onChangeSubcategory={(s) => {
            setEditSubcategory(s);
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
 * Confirm card — mirrors the visual treatment of the V2BrainPanel mic's
 * card. Anchored ABOVE the button because the AskPanel input row sits at
 * the bottom of the drawer (no room to drop a popover below).
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
        bottom: "calc(100% + 6px)",
        left: 0,
        zIndex: 100,
        width: 360,
        background: PALETTE.parchment,
        border: `1px solid ${PALETTE.border}`,
        borderRadius: 10,
        padding: 12,
        boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
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
