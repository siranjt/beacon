"use client";

/**
 * CommandPaletteProvider — mounts the Cmd+K palette + owns open state.
 * Phase E-9.
 *
 * Listens globally for Cmd+K (Mac) / Ctrl+K (Windows/Linux) on the document.
 * Calls preventDefault so it doesn't trigger Chrome's "focus URL bar"
 * shortcut on macOS.
 *
 * Mounted once in app/layout.tsx so the palette is available on every
 * route. Exposes nothing for now — Cmd+K is the canonical entry. If we
 * later want an inline trigger button (e.g. in AgentHeader), we can lift
 * the state into a React context and consume it via useCommandPalette().
 */

import { useEffect, useState } from "react";
import CommandPalette from "./CommandPalette";

export default function CommandPaletteProvider() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd+K on Mac, Ctrl+K elsewhere. Use both metaKey and ctrlKey so
      // it works regardless of platform without needing a userAgent sniff.
      const isToggle =
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "k" || e.key === "K");
      if (!isToggle) return;

      // Don't hijack Cmd+K when the user is mid-edit in an input that
      // genuinely uses Cmd+K (rare — most don't). The palette being open
      // is unambiguously useful; close on second press, open otherwise.
      e.preventDefault();
      setOpen((prev) => !prev);
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return <CommandPalette open={open} onClose={() => setOpen(false)} />;
}
