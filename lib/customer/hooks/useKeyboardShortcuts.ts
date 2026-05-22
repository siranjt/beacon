"use client";

import { useEffect, useRef } from "react";

export type ShortcutHandlers = {
  /** Open the help overlay (default: "?"). */
  onHelp?: () => void;
  /** Close currently-open overlay (default: Esc). */
  onEsc?: () => void;
  /** Cycle focus to next/previous card (j/k). */
  onCycleNext?: () => void;
  onCyclePrev?: () => void;
  /** Open detail page for focused card (→). */
  onOpenDetail?: () => void;
  /** Click primary action on focused card (c). */
  onClickPrimary?: () => void;
  /** Click snooze on focused card (s). */
  onClickSnooze?: () => void;
  /** Trigger global refresh (r). */
  onRefresh?: () => void;
  /** Focus the search input (/). */
  onFocusSearch?: () => void;
  /** Navigate to manager (g m). */
  onGotoManager?: () => void;
  /** Navigate to 1:1 picker (g o). */
  onGotoOneOnOne?: () => void;
  /** Whether shortcuts are enabled (default: true). */
  enabled?: boolean;
};

const SEQUENCE_RESET_MS = 1000;

/**
 * Phase 32 — useKeyboardShortcuts.
 *
 * Listens on `document` for keydown and dispatches to the provided handlers.
 * Ignores events when an input/textarea/select/contentEditable has focus,
 * so we don't hijack typing.
 *
 * Multi-key sequences (g+m, g+o) are tracked via a ref + setTimeout that
 * resets after 1s of no input.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const seqRef = useRef<{ pending: string | null; expiresAt: number }>({
    pending: null,
    expiresAt: 0,
  });

  useEffect(() => {
    if (handlers.enabled === false) return;
    function isEditable(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (target.isContentEditable) return true;
      return false;
    }

    function onKey(e: KeyboardEvent) {
      const h = handlersRef.current;
      // Always allow Esc.
      if (e.key === "Escape") {
        h.onEsc?.();
        return;
      }
      // Don't hijack typing.
      if (isEditable(e.target)) return;
      // Don't conflict with modifier-based shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const now = Date.now();

      // Multi-key sequence handling for `g` prefix.
      if (seqRef.current.pending === "g" && now <= seqRef.current.expiresAt) {
        if (e.key === "m") {
          e.preventDefault();
          seqRef.current = { pending: null, expiresAt: 0 };
          h.onGotoManager?.();
          return;
        }
        if (e.key === "o") {
          e.preventDefault();
          seqRef.current = { pending: null, expiresAt: 0 };
          h.onGotoOneOnOne?.();
          return;
        }
        // Any other key cancels the sequence (fall through).
        seqRef.current = { pending: null, expiresAt: 0 };
      }

      switch (e.key) {
        case "?":
          e.preventDefault();
          h.onHelp?.();
          break;
        case "j":
          if (!e.shiftKey) {
            e.preventDefault();
            h.onCycleNext?.();
          }
          break;
        case "k":
          if (!e.shiftKey) {
            e.preventDefault();
            h.onCyclePrev?.();
          }
          break;
        case "ArrowRight":
          h.onOpenDetail?.();
          break;
        case "c":
          if (!e.shiftKey) {
            e.preventDefault();
            h.onClickPrimary?.();
          }
          break;
        case "s":
          if (!e.shiftKey) {
            e.preventDefault();
            h.onClickSnooze?.();
          }
          break;
        case "r":
          if (!e.shiftKey) {
            e.preventDefault();
            h.onRefresh?.();
          }
          break;
        case "/":
          e.preventDefault();
          h.onFocusSearch?.();
          break;
        case "g":
          if (!e.shiftKey) {
            e.preventDefault();
            seqRef.current = { pending: "g", expiresAt: now + SEQUENCE_RESET_MS };
          }
          break;
        default:
          break;
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handlers.enabled]);
}

export default useKeyboardShortcuts;
