"use client";

/**
 * AskPanel — universal "Ask Beacon" copilot (Claude under the hood).
 * Phase E-9.
 *
 * Mounted once at the umbrella root layout. Detects scope from
 * usePathname() and adapts:
 *   - Quick-prompt chips change per scope
 *   - Endpoint /api/ai/ask receives the resolved scope + question
 *   - localStorage key is per-scope so each surface keeps its own history
 *   - Header subtitle says "About this customer" / "About the inbox" / etc.
 *
 * UX:
 *   - Floating "✨ Ask Beacon" button bottom-right (hidden when scope is
 *     "hidden" — auth pages, admin pages)
 *   - Click to open right-edge drawer
 *   - Esc / backdrop click to close
 *   - ⌘+Enter to send
 *   - Conversation persists in localStorage scoped to the current view
 *
 * Note on branding: this is *Beacon* — Zoca's customer-intelligence
 * copilot. It's powered by Claude (Anthropic) but speaks as Beacon. Users
 * never see "Claude" in the UI.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import {
  pathToScope,
  scopeKey,
  scopeLabel,
  scopeQuickPrompts,
  type AiScope,
} from "@/lib/ai/scopes";
import { BeaconMark } from "@/components/BeaconMark";

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

interface Turn {
  role: "user" | "assistant";
  content: string;
}

const MAX_HISTORY_TURNS = 5;

function storageKeyFor(scope: AiScope): string {
  return `beacon_ai_history_${scopeKey(scope)}`;
}

function readHistory(scope: AiScope): Turn[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKeyFor(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Turn[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-MAX_HISTORY_TURNS * 2);
  } catch {
    return [];
  }
}

function writeHistory(scope: AiScope, turns: Turn[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKeyFor(scope),
      JSON.stringify(turns.slice(-MAX_HISTORY_TURNS * 2)),
    );
  } catch {
    /* ignore quota */
  }
}

export default function AskPanel() {
  const pathname = usePathname() ?? "/";
  const scope: AiScope = pathToScope(pathname);

  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Hydrate history when the SCOPE changes (different URL = different
  // conversation context). Closing the panel is preserved across scope
  // changes — opening it again hydrates whichever conversation matches
  // the current scope.
  useEffect(() => {
    setTurns(readHistory(scope));
    // Don't reset `open` here — the user explicitly opened it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey(scope)]);

  // Persist on every turn change.
  useEffect(() => {
    writeHistory(scope, turns);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, scopeKey(scope)]);

  // Auto-scroll transcript on update.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns, streaming]);

  // Esc closes drawer (unless streaming, to avoid losing partial reply).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !streaming) {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => textareaRef.current?.focus());
    return () => document.removeEventListener("keydown", onKey);
  }, [open, streaming]);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || streaming) return;
      setErrorMsg(null);
      setDraft("");

      const history = turns.slice(-MAX_HISTORY_TURNS * 2);
      const userTurn: Turn = { role: "user", content: trimmed };
      setTurns((prev) => [
        ...prev,
        userTurn,
        { role: "assistant", content: "" },
      ]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch("/api/ai/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, question: trimmed, history }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const errBody = await res
            .json()
            .catch(() => ({ error: res.statusText }));
          throw new Error(errBody.error || `ai/ask ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const evt of events) {
            const line = evt.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            const obj = JSON.parse(payload) as {
              delta?: string;
              done?: boolean;
              error?: string;
            };
            if (obj.error) throw new Error(obj.error);
            if (obj.delta) {
              setTurns((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  next[next.length - 1] = {
                    role: "assistant",
                    content: last.content + obj.delta,
                  };
                }
                return next;
              });
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          // user cancelled — leave partial in place
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          setErrorMsg(msg);
          setTurns((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && !last.content) {
              return prev.slice(0, -1);
            }
            return prev;
          });
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }
    },
    [scope, streaming, turns],
  );

  const onSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      ask(draft);
    },
    [ask, draft],
  );

  const clearConversation = useCallback(() => {
    setTurns([]);
    setErrorMsg(null);
    writeHistory(scope, []);
  }, [scope]);

  if (scope.kind === "hidden") return null;

  const audience = scopeLabel(scope);
  const quickPrompts = scopeQuickPrompts(scope);

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Ask Beacon about ${audience}`}
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 80,
            padding: "12px 18px",
            borderRadius: 999,
            background: C.char,
            color: C.parchment,
            border: `1px solid ${C.char}`,
            fontFamily: SANS,
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
            boxShadow: "0 12px 28px -8px rgba(43,31,20,0.45)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          {/* Beacon flame mark — animated 4-layer flicker. Tower flips to
              parchment so it shows on the char button background; flame
              colors (ember + gold) stay default — they pop against char. */}
          <BeaconMark size={18} towerFill="#F0E4CC" flicker />
          Ask Beacon
          {turns.length > 0 && (
            <span
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 999,
                background: C.brass,
                color: C.char,
                fontWeight: 600,
              }}
            >
              {Math.ceil(turns.length / 2)}
            </span>
          )}
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Ask Beacon"
          onClick={() => {
            if (!streaming) setOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 90,
            background: "rgba(43, 31, 20, 0.35)",
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(480px, 92vw)",
              height: "100vh",
              background: C.surface,
              borderLeft: `1px solid ${C.border}`,
              boxShadow: "-16px 0 40px -16px rgba(43,31,20,0.45)",
              display: "flex",
              flexDirection: "column",
              fontFamily: SANS,
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: "16px 20px",
                borderBottom: `1px solid ${C.border}`,
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: SERIF,
                    fontSize: 17,
                    fontWeight: 500,
                    color: C.text,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {/* Same animated flame, default colors — char tower
                      reads well on the parchment drawer surface. */}
                  <BeaconMark size={20} flicker />
                  Ask Beacon
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: C.text3,
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 360,
                  }}
                >
                  About {audience}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {turns.length > 0 && (
                  <button
                    type="button"
                    onClick={clearConversation}
                    disabled={streaming}
                    style={ghostBtn(streaming)}
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={streaming}
                  style={ghostBtn(streaming)}
                >
                  Close
                </button>
              </div>
            </div>

            {/* Transcript */}
            <div
              ref={transcriptRef}
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "16px 20px",
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              {turns.length === 0 && (
                <div style={{ marginTop: 4 }}>
                  <div
                    style={{
                      fontFamily: SERIF,
                      fontStyle: "italic",
                      color: C.text2,
                      fontSize: 14,
                      lineHeight: 1.6,
                      marginBottom: 14,
                    }}
                  >
                    Ask anything about {audience}. Pick a starter below or
                    type your own question.
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr",
                      gap: 6,
                    }}
                  >
                    {quickPrompts.map((q) => (
                      <button
                        key={q.label}
                        type="button"
                        onClick={() => ask(q.prompt)}
                        disabled={streaming}
                        style={{
                          textAlign: "left",
                          padding: "10px 12px",
                          border: `1px solid ${C.border}`,
                          background: C.parchment,
                          borderRadius: 10,
                          fontFamily: SANS,
                          fontSize: 12.5,
                          color: C.text,
                          cursor: streaming ? "wait" : "pointer",
                          lineHeight: 1.4,
                        }}
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {turns.map((t, i) => (
                <Bubble
                  key={i}
                  role={t.role}
                  content={t.content}
                  streaming={streaming && i === turns.length - 1}
                />
              ))}

              {errorMsg && (
                <div
                  style={{
                    border: `1px solid ${C.ember}`,
                    background: "rgba(200, 67, 29, 0.06)",
                    borderRadius: 10,
                    padding: "10px 12px",
                    fontSize: 12,
                    color: C.ember,
                  }}
                >
                  {errorMsg}
                </div>
              )}
            </div>

            {/* Composer */}
            <form
              onSubmit={onSubmit}
              style={{
                padding: "12px 16px 16px",
                borderTop: `1px solid ${C.border}`,
                background: C.parchment,
              }}
            >
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    onSubmit();
                  }
                }}
                rows={2}
                placeholder={`Ask about ${audience}…  (⌘+Enter to send)`}
                disabled={streaming}
                style={{
                  width: "100%",
                  resize: "vertical",
                  minHeight: 44,
                  maxHeight: 200,
                  padding: "10px 12px",
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  background: "white",
                  fontFamily: "inherit",
                  fontSize: 13,
                  color: C.text,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
              <div
                style={{
                  marginTop: 8,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: 10,
                  color: C.text3,
                }}
              >
                <span>Beacon · grounded in {audience}</span>
                <button
                  type="submit"
                  disabled={streaming || !draft.trim()}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 8,
                    border: `1px solid ${C.char}`,
                    background:
                      streaming || !draft.trim() ? C.border : C.char,
                    color: C.parchment,
                    fontFamily: "inherit",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor:
                      streaming || !draft.trim() ? "not-allowed" : "pointer",
                  }}
                >
                  {streaming ? "Thinking…" : "Send"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function Bubble({
  role,
  content,
  streaming,
}: {
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
}) {
  const isUser = role === "user";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
      }}
    >
      <div
        style={{
          maxWidth: "92%",
          background: isUser ? C.char : C.parchment,
          color: isUser ? C.parchment : C.text,
          border: isUser ? `1px solid ${C.char}` : `1px solid ${C.border}`,
          borderRadius: 12,
          padding: "10px 12px",
          fontFamily: isUser ? SANS : SERIF,
          fontSize: isUser ? 13 : 13.5,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {content || (streaming ? <BlinkingCursor /> : "")}
        {streaming && content && (
          <span style={{ display: "inline-block", width: 0 }}>
            <BlinkingCursor />
          </span>
        )}
      </div>
    </div>
  );
}

function BlinkingCursor() {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 8,
        height: 14,
        verticalAlign: "-3px",
        marginLeft: 2,
        background: "currentColor",
        opacity: 0.6,
        animation: "blink 1s steps(1, end) infinite",
      }}
    />
  );
}

const ghostBtn = (disabled: boolean): React.CSSProperties => ({
  appearance: "none",
  padding: "4px 10px",
  borderRadius: 6,
  border: `1px solid ${C.border}`,
  background: "transparent",
  fontFamily: "inherit",
  fontSize: 11,
  color: C.text2,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.5 : 1,
});
