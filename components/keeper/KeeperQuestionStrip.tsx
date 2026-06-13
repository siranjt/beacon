"use client";

/**
 * WAVE-B-3 — KeeperQuestionStrip
 *
 * Renders 1..3 pending Keeper questions as small parchment cards above the
 * AskPanel composer. Each card shows the question, an Answer flow, and a
 * Dismiss × button. The strip never renders an "empty" state — when there
 * are no pending questions, the component returns null (avoids visual
 * noise on the Beam drawer's typical state).
 *
 * Style notes:
 *   - Brass/ember palette to match KeeperChip + the KeeperVault glyph.
 *   - Parchment surface, georgia-italic question text — reads like a
 *     handwritten margin note above the composer.
 *
 * Conflict handling: when /answer returns 409 (Wave-2b semantic_conflict),
 * the card surfaces an inline warning and leaves the form open so the AM
 * can adjust the value and resubmit. The "Save anyway" override route
 * lives elsewhere (Brain panel direct write) — out of scope for the strip
 * UI per the spec.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import KeeperVault from "./KeeperVault";
import {
  FIELD_CATALOG,
  type TopicSubcategory,
} from "@/lib/brain/types";

/* ──────────────────────────────────────────────────────────────────
 * Palette — matches KeeperChip's brass/ember/parchment register so the
 * strip sits coherently next to the Keeper panel + cite chips. Inline
 * rather than reaching for a global tokens file keeps the strip
 * self-contained.
 * ──────────────────────────────────────────────────────────────── */
const C = {
  parchment: "#fdf6ea",
  parchmentDeeper: "#f5ead0",
  brass: "#d9a441",
  brassDark: "#8a6014",
  ember: "#c8431d",
  emberDark: "#8b3416",
  patina: "#4a7c59",
  border: "rgba(218, 165, 32, 0.32)",
  text: "#2b1f14",
  text2: "#5b4a32",
  text3: "#8a7a5e",
} as const;

interface Question {
  id: number;
  question_text: string;
  customer_id: string | null;
  entity_id: string | null;
  category: "data_missing" | "tool_insufficient" | "out_of_scope" | "assumption_unclear";
  // Other fields exist on the row but are unused at the strip layer.
}

interface FetchResponse {
  ok: boolean;
  questions?: Question[];
}

interface AnswerSuccess {
  ok: true;
  fact: unknown;
  question: unknown;
}
interface AnswerConflict {
  ok: false;
  error: "semantic_conflict";
  conflict: {
    conflicting_fact_id: string;
    conflicting_value: string;
    similarity: number;
    proposed_value: string;
  };
}
interface AnswerError {
  ok: false;
  error: string;
}
type AnswerResponse = AnswerSuccess | AnswerConflict | AnswerError;

interface Props {
  /** Customer 360 / Performance scope passes entity_id (UUID). */
  entityId?: string;
  /** Direct Chargebee customer_id binding when the caller has it. Wins. */
  customerId?: string;
  /** Optional — included for parity with other Keeper components; the
   *  server resolves identity via session, so this isn't shipped to the
   *  request. */
  userEmail?: string;
  /** Fires after a successful answer so the parent can refresh suggestions
   *  / facts. Optional. */
  onAnswered?: () => void;
  /** Wrapper className for placement tweaks from the parent. */
  className?: string;
}

export default function KeeperQuestionStrip({
  entityId,
  customerId,
  onAnswered,
  className,
}: Props) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-question expanded form state. Keyed on question id.
  const [openForms, setOpenForms] = useState<Set<number>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const qs = useMemo(() => {
    const sp = new URLSearchParams();
    if (customerId) sp.set("customer_id", customerId);
    else if (entityId) sp.set("entity_id", entityId);
    sp.set("limit", "3");
    return sp.toString();
  }, [customerId, entityId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/keeper/questions?${qs}`)
      .then((r) => r.json() as Promise<FetchResponse>)
      .then((json) => {
        if (cancelled || !mountedRef.current) return;
        if (json.ok && Array.isArray(json.questions)) {
          setQuestions(json.questions);
        } else {
          setQuestions([]);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setQuestions([]);
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [qs]);

  const removeQuestion = useCallback((id: number) => {
    setQuestions((prev) => prev.filter((q) => q.id !== id));
    setOpenForms((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const toggleForm = useCallback((id: number) => {
    setOpenForms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleDismiss = useCallback(
    async (q: Question) => {
      // Optimistic remove. If the server fails we'll re-fetch on next
      // mount; failures here are rare and non-critical.
      removeQuestion(q.id);
      try {
        await fetch(`/api/keeper/questions/${q.id}/dismiss`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch {
        /* swallow — optimistic UI already applied */
      }
    },
    [removeQuestion],
  );

  // Render-nothing conditions per spec.
  if (loading) return null;
  if (error) return null;
  if (questions.length === 0) return null;

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 16px 6px",
      }}
    >
      {questions.map((q) => (
        <QuestionCard
          key={q.id}
          question={q}
          formOpen={openForms.has(q.id)}
          onToggleForm={() => toggleForm(q.id)}
          onDismiss={() => handleDismiss(q)}
          onAnswered={() => {
            removeQuestion(q.id);
            onAnswered?.();
          }}
        />
      ))}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Card sub-component — keeps the strip-level component tiny and lets
 * each card own its own form state without re-renders cascading across
 * siblings.
 * ──────────────────────────────────────────────────────────────── */

interface CardProps {
  question: Question;
  formOpen: boolean;
  onToggleForm: () => void;
  onDismiss: () => void;
  onAnswered: () => void;
}

function QuestionCard({
  question,
  formOpen,
  onToggleForm,
  onDismiss,
  onAnswered,
}: CardProps) {
  return (
    <div
      style={{
        border: `1px solid ${C.border}`,
        background: C.parchment,
        borderRadius: 8,
        padding: "10px 12px",
        boxShadow: "0 1px 0 rgba(217, 164, 65, 0.18)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <KeeperVault size={14} bodyColor={C.brassDark} dialColor={C.ember} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              fontWeight: 600,
              color: C.brassDark,
              marginBottom: 3,
            }}
          >
            Beam wants to learn
          </div>
          <div
            style={{
              fontFamily: "Georgia, serif",
              fontStyle: "italic",
              fontSize: 13.5,
              lineHeight: 1.35,
              color: C.text,
            }}
          >
            {question.question_text}
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            onClick={onToggleForm}
            style={{
              background: formOpen ? C.parchmentDeeper : "transparent",
              color: C.brassDark,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              fontSize: 11,
              padding: "3px 8px",
              cursor: "pointer",
            }}
          >
            {formOpen ? "Close" : "Answer"}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss this question"
            title="Dismiss"
            style={{
              background: "transparent",
              color: C.text3,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1,
              padding: "3px 7px",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
      </div>
      {formOpen && (
        <AnswerForm question={question} onAnswered={onAnswered} />
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Inline form. Three fields: subcategory (select), field_name (text),
 * value (text). Submit → POST /api/keeper/questions/[id]/answer. 409
 * shows an inline warning + leaves the form open.
 * ──────────────────────────────────────────────────────────────── */

interface FormProps {
  question: Question;
  onAnswered: () => void;
}

const SUBCATEGORY_OPTIONS = Object.keys(FIELD_CATALOG) as TopicSubcategory[];

function AnswerForm({ question, onAnswered }: FormProps) {
  const [subcategory, setSubcategory] = useState<TopicSubcategory>(
    // Default subcategory choice — owner_info is the most universally
    // applicable starting slot and the catalog's first entry.
    "owner_info",
  );
  const [fieldName, setFieldName] = useState<string>("other");
  const [value, setValue] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  // When subcategory changes, default field_name to the first named
  // field in the catalog (or 'other' if the subcategory has none).
  useEffect(() => {
    const named = FIELD_CATALOG[subcategory]?.named_fields ?? [];
    setFieldName(named[0] ?? "other");
  }, [subcategory]);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!value.trim() || submitting) return;
      setSubmitting(true);
      setWarning(null);
      try {
        const r = await fetch(
          `/api/keeper/questions/${question.id}/answer`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              answer_value: value.trim(),
              topic_subcategory: subcategory,
              field_name: fieldName.trim() || "other",
            }),
          },
        );
        if (r.status === 409) {
          const conflict = (await r.json()) as AnswerConflict;
          setWarning(
            `This conflicts with an existing fact (${(conflict.conflict.similarity * 100).toFixed(0)}% match: "${conflict.conflict.conflicting_value.slice(0, 60)}") — try a different value, or skip.`,
          );
          return;
        }
        if (!r.ok) {
          const json = (await r.json().catch(() => ({}))) as AnswerError;
          setWarning(json.error || `Save failed (HTTP ${r.status})`);
          return;
        }
        // Success — the parent will remove the card from the list.
        onAnswered();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setWarning(msg);
      } finally {
        setSubmitting(false);
      }
    },
    [fieldName, onAnswered, question.id, subcategory, submitting, value],
  );

  const namedFields = FIELD_CATALOG[subcategory]?.named_fields ?? [];

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        marginTop: 10,
        paddingTop: 10,
        borderTop: `1px dashed ${C.border}`,
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 8,
      }}
    >
      <label style={{ fontSize: 10, color: C.text3 }}>
        Topic
        <select
          value={subcategory}
          onChange={(e) => setSubcategory(e.target.value as TopicSubcategory)}
          style={inputStyle}
        >
          {SUBCATEGORY_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label style={{ fontSize: 10, color: C.text3 }}>
        Field
        <select
          value={namedFields.includes(fieldName) ? fieldName : "other"}
          onChange={(e) => setFieldName(e.target.value)}
          style={inputStyle}
        >
          {namedFields.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          <option value="other">other</option>
        </select>
      </label>
      <label
        style={{
          fontSize: 10,
          color: C.text3,
          gridColumn: "1 / span 2",
        }}
      >
        Value
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="What's the answer?"
          style={inputStyle}
          autoFocus
        />
      </label>
      {warning && (
        <div
          style={{
            gridColumn: "1 / span 2",
            fontSize: 11,
            color: C.emberDark,
            background: "rgba(200, 67, 29, 0.06)",
            border: `1px solid rgba(200, 67, 29, 0.2)`,
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          {warning}
        </div>
      )}
      <div
        style={{
          gridColumn: "1 / span 2",
          display: "flex",
          justifyContent: "flex-end",
          gap: 6,
        }}
      >
        <button
          type="submit"
          disabled={!value.trim() || submitting}
          style={{
            background: submitting ? C.parchmentDeeper : C.brass,
            color: submitting ? C.text3 : "white",
            border: `1px solid ${C.brass}`,
            borderRadius: 6,
            fontSize: 11,
            padding: "5px 12px",
            cursor: submitting ? "default" : "pointer",
          }}
        >
          {submitting ? "Saving…" : "Save fact"}
        </button>
      </div>
    </form>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 2,
  padding: "5px 8px",
  fontSize: 12,
  color: C.text,
  background: "white",
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  boxSizing: "border-box",
  fontFamily: "inherit",
};
