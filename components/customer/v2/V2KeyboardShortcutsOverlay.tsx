"use client";

import * as React from "react";
import { createPortal } from "react-dom";

type Props = {
  open: boolean;
  onClose: () => void;
};

type Shortcut = { keys: string[]; label: string };
type Group = { title: string; shortcuts: Shortcut[] };

const GROUPS: Group[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: ["j"], label: "Focus next customer card" },
      { keys: ["k"], label: "Focus previous customer card" },
      { keys: ["→"], label: "Open detail page for focused card" },
      { keys: ["g", "m"], label: "Go to Manager view" },
      { keys: ["g", "o"], label: "Go to 1:1 picker" },
      { keys: ["/"], label: "Focus search input" },
    ],
  },
  {
    title: "Actions",
    shortcuts: [
      { keys: ["c"], label: "Log primary action on focused card" },
      { keys: ["s"], label: "Snooze focused card" },
      { keys: ["r"], label: "Refresh live data" },
    ],
  },
  {
    title: "Misc",
    shortcuts: [
      { keys: ["?"], label: "Show this help overlay" },
      { keys: ["Esc"], label: "Close any open overlay" },
    ],
  },
];

/**
 * Phase 32 — V2KeyboardShortcutsOverlay.
 *
 * Cheat sheet modal triggered by `?`. Mounted via portal. Fades in via the
 * shared `zoca-fade-in` class. Esc dismisses.
 */
export default function V2KeyboardShortcutsOverlay({ open, onClose }: Props) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      data-v2-shortcuts-overlay="1"
      onClick={onClose}
      className="zoca-fade-in"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(11, 5, 29, 0.55)",
        zIndex: 9700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft"
        style={{
          width: "min(560px, 100%)",
          maxHeight: "min(80vh, 720px)",
          overflowY: "auto",
          padding: "24px 28px",
          boxShadow: "0 24px 60px rgba(11,5,29,0.28)",
        }}
      >
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[18px] font-bold tracking-tight text-zoca-text">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts overlay"
            className="text-zoca-text-2 hover:text-zoca-text focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
            style={{ fontSize: "18px", padding: "0 4px" }}
          >
            ×
          </button>
        </div>
        <p className="mt-1 text-[12px] text-zoca-text-2">
          Power moves to fly through your book without touching the mouse.
        </p>

        <div className="mt-4 grid gap-5">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zoca-text-3">
                {g.title}
              </h3>
              <ul className="space-y-1.5">
                {g.shortcuts.map((sc) => (
                  <li
                    key={sc.label}
                    className="flex items-center justify-between gap-3 text-[12.5px] text-zoca-text"
                  >
                    <span>{sc.label}</span>
                    <span className="flex items-center gap-1">
                      {sc.keys.map((k, i) => (
                        <React.Fragment key={`${sc.label}-${k}-${i}`}>
                          {i > 0 && (
                            <span className="text-[10px] text-zoca-text-3">then</span>
                          )}
                          <kbd
                            className="inline-flex items-center justify-center rounded border border-zoca-border bg-zoca-bg-soft font-mono text-[11px] text-zoca-text"
                            style={{
                              minWidth: 22,
                              padding: "2px 6px",
                              boxShadow: "0 1px 0 rgba(0,0,0,0.04)",
                            }}
                          >
                            {k}
                          </kbd>
                        </React.Fragment>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="mt-6 border-t border-zoca-border pt-3 text-[11px] text-zoca-text-3">
          Press <kbd className="rounded border border-zoca-border bg-zoca-bg-soft px-1 font-mono">Esc</kbd> to close.
        </div>
      </div>
    </div>,
    document.body,
  );
}
