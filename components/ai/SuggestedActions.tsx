"use client";

/**
 * SuggestedActions — Beam proactive recommendations strip.
 * Phase E-9.
 *
 * Renders 2-3 cards above the main content on Customer 360. Each card is
 * one click:
 *   - "ask"      → dispatches "beacon-ai:open" custom event, AskPanel
 *                  catches it, opens drawer + pre-fills prompt
 *   - "draft"    → same dispatch, just framed as a draft request
 *   - "navigate" → href link, in-app or to Linear (sanitized server-side)
 *
 * Loading shows three skeleton cards. Empty result hides the strip
 * entirely (no actions, no clutter).
 */

import { useEffect, useState } from "react";
import { useActivityLogger } from "@/components/hooks/use-activity-logger";
import type { AiScope } from "@/lib/ai/scopes";

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
  lapis: "#2A4D5C",
  patina: "#4A7C59",
  char: "#2B1F14",
};

type ActionKind = "ask" | "draft" | "navigate";

interface SuggestedAction {
  kind: ActionKind;
  label: string;
  why: string;
  prompt?: string;
  href?: string;
}

interface ApiResponse {
  actions: SuggestedAction[];
  audience: string;
  generated_at: string;
}

interface Props {
  scope: AiScope;
}

const KIND_TONE: Record<ActionKind, { color: string; icon: string; label: string }> = {
  ask: { color: C.lapis, icon: "❓", label: "Ask" },
  draft: { color: C.brass, icon: "✎", label: "Draft" },
  navigate: { color: C.patina, icon: "→", label: "Open" },
};

export default function SuggestedActions({ scope }: Props) {
  const [actions, setActions] = useState<SuggestedAction[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);
  const log = useActivityLogger("umbrella");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrored(false);
    setActions(null);

    (async () => {
      try {
        const res = await fetch("/api/ai/suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope }),
        });
        if (!res.ok) throw new Error(`suggest ${res.status}`);
        const json = (await res.json()) as ApiResponse;
        if (!cancelled) setActions(json.actions);
      } catch {
        if (!cancelled) setErrored(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scope]);

  const onClick = (a: SuggestedAction) => {
    // Telemetry first so the click registers even if navigation tears down.
    log("suggestion_acted", {
      surface: "launcher",
      metadata: {
        kind: a.kind,
        label: a.label.slice(0, 80),
      },
    });

    if (a.kind === "navigate" && a.href) {
      // External Linear urls open in new tab; internal paths in same.
      if (a.href.startsWith("http")) {
        window.open(a.href, "_blank", "noopener,noreferrer");
      } else {
        window.location.href = a.href;
      }
      return;
    }

    // ask / draft → dispatch event the AskPanel listens for. The custom
    // event carries the prompt + a flag so AskPanel knows to auto-submit
    // (drafts) vs just pre-fill (asks for the user to edit).
    if (a.prompt) {
      const evt = new CustomEvent("beacon-ai:open", {
        detail: {
          prompt: a.prompt,
          autoSubmit: a.kind === "draft",
        },
      });
      window.dispatchEvent(evt);
    }
  };

  // Don't render anything if the API failed or returned no actions.
  // We don't want a permanent empty strip cluttering the page.
  if (errored || (actions !== null && actions.length === 0 && !loading)) {
    return null;
  }

  return (
    <div
      style={{
        marginBottom: 16,
        padding: "10px 16px",
        background: C.parchment,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: SANS,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: C.text3,
        }}
      >
        <Spark /> Beam suggests
      </div>

      {loading && <SkeletonRow />}

      {!loading && actions && actions.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 8,
          }}
        >
          {actions.map((a, i) => {
            const tone = KIND_TONE[a.kind];
            return (
              <button
                key={i}
                type="button"
                onClick={() => onClick(a)}
                style={{
                  textAlign: "left",
                  padding: "12px 14px",
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderLeft: `3px solid ${tone.color}`,
                  borderRadius: 8,
                  cursor: "pointer",
                  fontFamily: SANS,
                  color: C.text,
                  transition:
                    "transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-1px)";
                  e.currentTarget.style.boxShadow =
                    "0 4px 12px -4px rgba(43,31,20,0.18)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translateY(0)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      color: tone.color,
                    }}
                  >
                    {tone.label}
                  </span>
                </div>
                <div
                  style={{
                    fontFamily: SERIF,
                    fontSize: 14,
                    fontWeight: 500,
                    color: C.text,
                    lineHeight: 1.35,
                    marginBottom: 4,
                  }}
                >
                  {a.label}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: C.text2,
                    lineHeight: 1.45,
                  }}
                >
                  {a.why}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: 8,
      }}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            height: 76,
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            opacity: 0.5 - i * 0.1,
          }}
        />
      ))}
    </div>
  );
}

function Spark() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden style={{ flexShrink: 0 }}>
      <path
        fill="currentColor"
        d="M8 0 L9 5 L14 6 L9 7 L8 12 L7 7 L2 6 L7 5 Z"
      />
    </svg>
  );
}
