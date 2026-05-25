"use client";

/**
 * KeyboardShortcuts — global power-user shortcuts. Phase E-9.
 *
 * Mounted once at root layout (alongside CommandPaletteProvider). Listens
 * for shortcut keys on the document but stays out of the way when the user
 * is typing in an input/textarea/contenteditable.
 *
 * Shortcuts:
 *   ?              Open shortcut help dialog
 *   Esc            Close any open modal / dialog
 *   g then h       Go to launcher (umbrella home)
 *   g then c       Go to Customer Beacon
 *   g then p       Go to Performance Beacon
 *   g then e       Go to Escalation Beacon
 *   g then v       Go to Post-Payment Reviews (verdicts)
 *   g then a       Go to Admin · Activity (admin only — silently no-ops otherwise)
 *
 * The `g`-prefix follows Gmail/Linear convention — first press starts a
 * 1.5s "go to" sequence, second press picks the destination. Pressing
 * anything else (or letting the timer expire) cancels.
 *
 * Cmd+K is handled separately by CommandPaletteProvider; we explicitly
 * don't fight for it here.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Shortcut {
  keys: string[];
  description: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: ["⌘", "K"], description: "Open command palette" },
  { keys: ["?"], description: "Show this dialog" },
  { keys: ["Esc"], description: "Close any modal" },
  { keys: ["g", "h"], description: "Go to launcher home" },
  { keys: ["g", "c"], description: "Go to Customer Beacon" },
  { keys: ["g", "p"], description: "Go to Performance Beacon" },
  { keys: ["g", "e"], description: "Go to Escalation Beacon" },
  { keys: ["g", "v"], description: "Go to Post-Payment Reviews" },
  { keys: ["g", "a"], description: "Go to Admin · Activity (admin only)" },
];

const GOTO_TIMEOUT_MS = 1500;

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export default function KeyboardShortcuts() {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const [gotoArmed, setGotoArmed] = useState(false);

  // Reset the goto-armed state after the timeout.
  useEffect(() => {
    if (!gotoArmed) return;
    const t = setTimeout(() => setGotoArmed(false), GOTO_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [gotoArmed]);

  const handleGoto = useCallback(
    (key: string): boolean => {
      switch (key) {
        case "h":
          router.push("/");
          return true;
        case "c":
          router.push("/customer");
          return true;
        case "p":
          router.push("/performance");
          return true;
        case "e":
          router.push("/escalation");
          return true;
        case "v":
          router.push("/post-payment");
          return true;
        case "a":
          router.push("/admin/activity");
          return true;
        default:
          return false;
      }
    },
    [router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when the user is typing — never steal keystrokes from inputs.
      if (isTextInputTarget(e.target)) return;
      // Skip modifier-led keystrokes (Cmd+K et al.) — those have their own
      // handlers and shouldn't reset the goto-armed state.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // "?" — show help (Shift+/ on most layouts)
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((o) => !o);
        return;
      }

      // Esc — close help if open. (Modal-specific Esc handlers handle their
      // own boxes; we only act on the help dialog here.)
      if (e.key === "Escape") {
        if (helpOpen) {
          e.preventDefault();
          setHelpOpen(false);
          return;
        }
        // Cancel pending goto on Esc.
        if (gotoArmed) {
          setGotoArmed(false);
          return;
        }
        return;
      }

      const k = e.key.toLowerCase();

      // Start a goto sequence on `g`.
      if (k === "g" && !gotoArmed) {
        e.preventDefault();
        setGotoArmed(true);
        return;
      }

      // Second key of a goto sequence — try to route, then disarm.
      if (gotoArmed) {
        const handled = handleGoto(k);
        if (handled) e.preventDefault();
        setGotoArmed(false);
        return;
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [gotoArmed, helpOpen, handleGoto]);

  return (
    <>
      {gotoArmed && <GotoHint />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </>
  );
}

function GotoHint() {
  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 90,
        background: "rgba(43, 31, 20, 0.92)",
        color: "#F0E4CC",
        padding: "8px 14px",
        borderRadius: 999,
        fontFamily: "-apple-system, Inter, system-ui, sans-serif",
        fontSize: 12,
        boxShadow: "0 8px 24px -8px rgba(43,31,20,0.45)",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span style={{ opacity: 0.7 }}>Go to…</span>
      <span style={{ display: "flex", gap: 4 }}>
        {["h", "c", "p", "e", "v", "a"].map((k) => (
          <kbd
            key={k}
            style={{
              fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
              padding: "1px 6px",
              borderRadius: 4,
              background: "rgba(240, 228, 204, 0.15)",
              border: "1px solid rgba(240, 228, 204, 0.25)",
              fontSize: 11,
            }}
          >
            {k}
          </kbd>
        ))}
      </span>
    </div>
  );
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        background: "rgba(43, 31, 20, 0.55)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, calc(100vw - 32px))",
          background: "#F8EFD7",
          border: "1px solid #D4C29B",
          borderRadius: 14,
          padding: "20px 24px",
          boxShadow:
            "0 24px 60px -20px rgba(43,31,20,0.55), 0 8px 20px -8px rgba(43,31,20,0.35)",
          fontFamily: "-apple-system, Inter, system-ui, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 14,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: 18,
              fontWeight: 500,
              color: "#2B1F14",
            }}
          >
            Keyboard shortcuts
          </h2>
          <kbd
            style={{
              fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
              fontSize: 11,
              padding: "2px 6px",
              border: "1px solid #D4C29B",
              borderRadius: 4,
              color: "#6E5F50",
              background: "#F0E4CC",
            }}
          >
            Esc
          </kbd>
        </div>

        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {SHORTCUTS.map((s, i) => (
            <li
              key={i}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ fontSize: 13, color: "#2B1F14" }}>
                {s.description}
              </span>
              <span style={{ display: "flex", gap: 4 }}>
                {s.keys.map((k, j) => (
                  <kbd
                    key={j}
                    style={{
                      fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
                      fontSize: 11,
                      padding: "2px 6px",
                      border: "1px solid #D4C29B",
                      borderRadius: 4,
                      background: "#F0E4CC",
                      color: "#2B1F14",
                    }}
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>

        <div
          style={{
            marginTop: 16,
            paddingTop: 12,
            borderTop: "1px solid #D4C29B",
            fontSize: 11,
            color: "#8B7A66",
          }}
        >
          For two-key sequences (g then h), press the first key, then the
          second within 1.5 seconds.
        </div>
      </div>
    </div>
  );
}
