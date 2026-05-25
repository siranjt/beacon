"use client";

/**
 * Beacon AI working-style onboarding — Phase E-12 (E-12.4).
 *
 * Two surfaces:
 *   1. **Inline card** in the AskPanel — shown only to users with zero
 *      onboarding facts. Clicking "Set up" expands the 4-question form.
 *   2. **Standalone form** in /settings/beacon-ai — always visible so users
 *      can revisit / overwrite their answers later.
 *
 * The component reads /api/ai/onboarding to decide whether to render the
 * nudge state (no onboarding yet) or a "Edit your style" link (already set).
 * Submits 4 answers in a single POST to /api/ai/onboarding.
 *
 * Design choice: explicit picker (radio-buttoned) instead of free text. The
 * goal is to make this take 30 seconds, not 5 minutes. Power users can still
 * use /remember in the AskPanel to add nuance.
 */

import { useEffect, useState } from "react";

interface Question {
  key: "length" | "format" | "depth" | "tone";
  prompt: string;
  hint: string;
  choices: Array<{ value: string; label: string; description: string }>;
}

const QUESTIONS: Question[] = [
  {
    key: "length",
    prompt: "How long should responses usually be?",
    hint: "You can always ask for more or less — this just sets the default.",
    choices: [
      { value: "brief", label: "Brief", description: "1-2 sentences" },
      { value: "standard", label: "Standard", description: "1-2 paragraphs" },
      { value: "detailed", label: "Detailed", description: "Multi-section" },
    ],
  },
  {
    key: "format",
    prompt: "Bullets or prose?",
    hint: "Affects how Beacon structures answers by default.",
    choices: [
      { value: "bullets", label: "Bullets", description: "Lists, scannable" },
      { value: "prose", label: "Prose", description: "Flowing paragraphs" },
      { value: "mixed", label: "Either", description: "Whatever fits the question" },
    ],
  },
  {
    key: "depth",
    prompt: "How much reasoning do you want?",
    hint: "Some people want just the answer; others want the why.",
    choices: [
      { value: "answer_only", label: "Just the answer", description: "No reasoning shown" },
      { value: "with_reasoning", label: "Answer + a reason", description: "One-line why" },
      { value: "explore_options", label: "Options + trade-offs", description: "2-3 choices laid out" },
    ],
  },
  {
    key: "tone",
    prompt: "What tone fits you?",
    hint: "Beacon will lean into this voice when drafting outreach, summaries, etc.",
    choices: [
      { value: "terse", label: "Terse", description: "Direct, no fluff" },
      { value: "warm", label: "Warm", description: "Encouraging, human" },
      { value: "formal", label: "Formal", description: "Professional, polished" },
    ],
  },
];

type Answers = Partial<Record<Question["key"], string>>;

interface Props {
  /** Compact mode for AskPanel — auto-detects completion and renders a nudge.
   *  When false (settings page), renders the form unconditionally. */
  compact?: boolean;
  /** Called after a successful save so the parent can dismiss / refresh. */
  onComplete?: () => void;
}

export default function StyleOnboarding({ compact = false, onComplete }: Props) {
  const [loading, setLoading] = useState(true);
  const [completed, setCompleted] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(!compact);
  const [answers, setAnswers] = useState<Answers>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ai/onboarding", { cache: "no-store" });
        if (!res.ok) throw new Error(`onboarding ${res.status}`);
        const json = (await res.json()) as { completed: boolean };
        if (!cancelled) setCompleted(json.completed);
      } catch {
        // Silent fall-through — assume completed so we don't nag on errors
        if (!cancelled) setCompleted(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // In compact mode, if onboarding is already done, render nothing —
  // the nudge has done its job and won't reappear.
  if (loading) return null;
  if (compact && completed) return null;

  const allAnswered = QUESTIONS.every((q) => Boolean(answers[q.key]));

  async function handleSubmit() {
    if (!allAnswered) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(answers),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `onboarding ${res.status}`);
      }
      setCompleted(true);
      setExpanded(false);
      onComplete?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Compact / nudge state — small banner offering the setup.
  if (compact && !expanded) {
    return (
      <div
        style={{
          padding: 12,
          background: "rgba(217, 164, 65, 0.08)",
          border: "1px solid rgba(217, 164, 65, 0.32)",
          borderRadius: 10,
          fontSize: 12,
          color: "#7C2D12",
          fontFamily: 'Georgia, "Times New Roman", serif',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          ✨ Personalize Beacon AI in 30 seconds
        </div>
        <div style={{ opacity: 0.85, lineHeight: 1.45 }}>
          Tell Beacon how you like responses — length, format, depth, tone — and it&apos;ll match
          your style on every answer. You can change these anytime in settings.
        </div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{
            marginTop: 8,
            padding: "6px 12px",
            background: "#7C2D12",
            color: "#F0E4CC",
            border: "none",
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Set up working style
        </button>
      </div>
    );
  }

  // Expanded form — same shape whether triggered from compact-nudge or
  // rendered on the settings page.
  return (
    <div
      style={{
        padding: compact ? 12 : 16,
        background: "rgba(240, 228, 204, 0.4)",
        border: "1px solid rgba(43, 31, 20, 0.12)",
        borderRadius: 10,
        fontFamily: 'Georgia, "Times New Roman", serif',
        color: "#2B1F14",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
        Working style {completed ? "(edit)" : "(set-up)"}
      </div>
      <div style={{ fontSize: 11, color: "#6E5F50", marginBottom: 12, lineHeight: 1.5 }}>
        Beacon AI applies these defaults to every response. Override individual
        answers with <code style={{ background: "rgba(0,0,0,0.05)", padding: "0 4px", borderRadius: 3 }}>/remember</code> in any conversation.
      </div>

      {QUESTIONS.map((q) => (
        <div key={q.key} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{q.prompt}</div>
          <div style={{ fontSize: 10, color: "#8B7A66", marginBottom: 6, fontStyle: "italic" }}>
            {q.hint}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {q.choices.map((c) => {
              const active = answers[q.key] === c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setAnswers((prev) => ({ ...prev, [q.key]: c.value }))}
                  style={{
                    padding: "6px 10px",
                    background: active ? "#2A4D5C" : "transparent",
                    color: active ? "#F0E4CC" : "#2B1F14",
                    border: `1px solid ${active ? "#2A4D5C" : "rgba(43, 31, 20, 0.24)"}`,
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: active ? 600 : 500,
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "all 120ms ease",
                  }}
                >
                  <div>{c.label}</div>
                  <div style={{ fontSize: 9, opacity: 0.75, marginTop: 1 }}>{c.description}</div>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {error && (
        <div style={{ fontSize: 11, color: "#C8431D", marginBottom: 8 }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!allAnswered || saving}
          style={{
            padding: "6px 14px",
            background: allAnswered && !saving ? "#2A4D5C" : "#9CA3AF",
            color: "#F0E4CC",
            border: "none",
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 600,
            cursor: allAnswered && !saving ? "pointer" : "not-allowed",
          }}
        >
          {saving ? "Saving…" : completed ? "Save changes" : "Save & start using Beacon"}
        </button>
        {compact && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            disabled={saving}
            style={{
              padding: "6px 12px",
              background: "transparent",
              border: "1px solid rgba(43, 31, 20, 0.24)",
              borderRadius: 6,
              fontSize: 11,
              cursor: "pointer",
              color: "#6E5F50",
            }}
          >
            Maybe later
          </button>
        )}
      </div>
    </div>
  );
}
