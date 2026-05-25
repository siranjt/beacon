"use client";

/**
 * FactsSettings — Beacon AI memory management UI.
 * Phase E-9 · Phase 2.
 */

import { useCallback, useEffect, useState } from "react";
import SectionErrorBoundary from "@/components/SectionErrorBoundary";
// Phase E-12 (E-12.4) — working-style onboarding lives in its own component
// and is reused both as the AskPanel first-login nudge AND as an editable
// section on this settings page.
import StyleOnboarding from "@/components/ai/StyleOnboarding";

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = "-apple-system, Inter, system-ui, sans-serif";

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
  lapis: "#2A4D5C",
  char: "#2B1F14",
};

interface UserFact {
  id: number;
  email: string;
  fact: string;
  // Phase E-12 — widened to include style/tone/depth/onboarding categories
  // emitted by the sharpened extraction prompt + onboarding flow.
  category:
    | "preference"
    | "context"
    | "behavior"
    | "explicit"
    | "style"
    | "tone"
    | "depth"
    | "onboarding"
    | null;
  // Phase E-12 — source widened to cover onboarding-authored and
  // feedback-authored facts (currently only extracted/explicit/onboarding
  // are emitted; "feedback" is reserved for a future learning loop).
  source: "extracted" | "explicit" | "onboarding" | "feedback";
  confidence: number;
  created_at: string;
  last_seen_at: string;
  reference_count: number;
  active: boolean;
  scope_key?: string | null;
}

const CATEGORY_TONE: Record<string, { color: string; label: string }> = {
  explicit: { color: C.lapis, label: "Explicit" },
  preference: { color: C.brass, label: "Preference" },
  context: { color: C.ember, label: "Context" },
  behavior: { color: C.patina, label: "Behavior" },
  // Phase E-12 — three new style-dimension categories.
  style: { color: C.lapis, label: "Style" },
  tone: { color: C.patina, label: "Tone" },
  depth: { color: C.brass, label: "Depth" },
  onboarding: { color: C.lapis, label: "Onboarding" },
};

export default function FactsSettings() {
  const [facts, setFacts] = useState<UserFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFacts = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/facts", { cache: "no-store" });
      if (!res.ok) throw new Error(`facts ${res.status}`);
      const json = (await res.json()) as { facts: UserFact[] };
      setFacts(json.facts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFacts();
  }, [loadFacts]);

  const onAdd = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const fact = draft.trim();
      if (!fact || adding) return;
      setAdding(true);
      setError(null);
      try {
        const res = await fetch("/api/ai/facts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fact }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(body.error || `add ${res.status}`);
        }
        setDraft("");
        await loadFacts();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setAdding(false);
      }
    },
    [draft, adding, loadFacts],
  );

  const onForget = useCallback(
    async (id: number) => {
      try {
        const res = await fetch(`/api/ai/facts?id=${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`delete ${res.status}`);
        setFacts((prev) => prev.filter((f) => f.id !== id));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "16px 0 64px" }}>
      <h1
        style={{
          margin: 0,
          marginBottom: 6,
          fontFamily: SERIF,
          fontSize: 28,
          fontWeight: 500,
          color: C.text,
          letterSpacing: "-0.01em",
        }}
      >
        What Beacon AI knows about you
      </h1>
      <p
        style={{
          margin: "0 0 24px",
          fontFamily: SERIF,
          fontStyle: "italic",
          fontSize: 14,
          color: C.text2,
          lineHeight: 1.6,
        }}
      >
        Beacon AI builds a picture of how you work over time — your preferred
        response style, the customers and AMs you focus on, when you tend to
        ask things. These facts get woven into every response so Beacon AI
        sharpens for you specifically. Add your own with the box below or via
        <code style={kbdInline}>/remember X</code> in the chat. Delete
        anything you don&apos;t want it to apply.
      </p>

      {/* Phase E-12 (E-12.4) — working-style onboarding. Always rendered on
          this settings page (compact=false). Users can re-submit to overwrite
          their answers. Existing answers stay in the facts list below. */}
      <SectionErrorBoundary label="Working style">
        <div style={{ marginBottom: 24 }}>
          <StyleOnboarding compact={false} onComplete={loadFacts} />
        </div>
      </SectionErrorBoundary>

      <SectionErrorBoundary label="Add explicit fact">
        <form
          onSubmit={onAdd}
          style={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            padding: "12px 14px",
            marginBottom: 24,
          }}
        >
          <label
            style={{
              fontFamily: SANS,
              fontSize: 11,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: C.text3,
              display: "block",
              marginBottom: 6,
            }}
          >
            Teach Beacon AI something
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. I always want bullet summaries, not paragraphs."
              maxLength={280}
              disabled={adding}
              style={{
                flex: 1,
                padding: "8px 10px",
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                fontFamily: "inherit",
                fontSize: 13,
                background: "white",
                color: C.text,
                outline: "none",
              }}
            />
            <button
              type="submit"
              disabled={adding || !draft.trim()}
              style={{
                padding: "8px 14px",
                borderRadius: 6,
                border: `1px solid ${C.char}`,
                background: adding || !draft.trim() ? C.border : C.char,
                color: C.parchment,
                fontFamily: "inherit",
                fontSize: 12,
                fontWeight: 500,
                cursor: adding || !draft.trim() ? "not-allowed" : "pointer",
              }}
            >
              {adding ? "Saving…" : "Remember"}
            </button>
          </div>
          {error && (
            <div
              style={{
                marginTop: 8,
                fontFamily: SANS,
                fontSize: 12,
                color: C.ember,
              }}
            >
              {error}
            </div>
          )}
        </form>
      </SectionErrorBoundary>

      <div
        style={{
          fontFamily: SANS,
          fontSize: 11,
          color: C.text3,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        {loading
          ? "Loading…"
          : facts.length === 0
          ? "No facts yet — keep using Beacon AI and ones will appear here"
          : `${facts.length} fact${facts.length === 1 ? "" : "s"} active`}
      </div>

      {!loading && facts.length === 0 && (
        <div
          style={{
            background: C.surface,
            border: `1px dashed ${C.border}`,
            borderRadius: 12,
            padding: "32px 20px",
            textAlign: "center",
            fontFamily: SERIF,
            fontStyle: "italic",
            color: C.text3,
          }}
        >
          The fact-extraction cron runs every 12 hours over your recent
          conversations. Once you&apos;ve had a few conversations with Beacon
          AI, stable patterns will start showing up here.
        </div>
      )}

      {facts.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {facts.map((f) => {
            const tone =
              (f.category && CATEGORY_TONE[f.category]) ||
              CATEGORY_TONE.explicit;
            return (
              <li
                key={f.id}
                style={{
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 10,
                  padding: "12px 14px",
                  marginBottom: 8,
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: SERIF,
                      fontSize: 14,
                      color: C.text,
                      lineHeight: 1.5,
                    }}
                  >
                    {f.fact}
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      flexWrap: "wrap",
                      fontFamily: SANS,
                      fontSize: 10,
                      color: C.text3,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: `${tone.color}15`,
                        color: tone.color,
                      }}
                    >
                      {tone.label}
                    </span>
                    <span>
                      {f.source === "explicit" ? "via /remember" : "auto-extracted"}
                    </span>
                    <span>conf {(f.confidence * 100).toFixed(0)}%</span>
                    <span>seen {f.last_seen_at.slice(0, 10)}</span>
                    {f.reference_count > 0 && (
                      <span>· refs {f.reference_count}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onForget(f.id)}
                  title="Forget this fact"
                  style={{
                    fontSize: 11,
                    padding: "4px 10px",
                    borderRadius: 6,
                    border: `1px solid ${C.border}`,
                    background: "transparent",
                    color: C.text2,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    flexShrink: 0,
                  }}
                >
                  Forget
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const kbdInline: React.CSSProperties = {
  fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
  fontSize: 11,
  padding: "1px 6px",
  margin: "0 4px",
  border: "1px solid #D4C29B",
  borderRadius: 4,
  background: "#F0E4CC",
  color: "#2B1F14",
};
