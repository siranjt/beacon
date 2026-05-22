"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (1 hex/rgba + 0 tailwind-rose swept)

import * as React from "react";
import { createPortal } from "react-dom";

type Props = {
  x: number;
  y: number;
  color?: string;
  onDone?: () => void;
};

const DURATION_MS = 600;
const SIZE_PX = 80;

/**
 * Phase 32 — V2SuccessRipple.
 *
 * Renders a 2px ring that expands from 0px radius to 80px while fading
 * from opacity 0.6 to 0 over 600ms. Pinned to a document-space (x, y).
 * Pure DOM + CSS keyframe (`v2-success-ripple` in globals.css).
 *
 * Respects prefers-reduced-motion (renders nothing).
 */
export default function V2SuccessRipple({ x, y, color = "#C8431D", onDone }: Props) {
  const [mounted, setMounted] = React.useState(false);
  const reduced = useReducedMotion();

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!onDone) return;
    if (reduced) {
      const id = window.setTimeout(onDone, 0);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(onDone, DURATION_MS + 50);
    return () => window.clearTimeout(id);
  }, [onDone, reduced]);

  if (!mounted || reduced) return null;

  return createPortal(
    <div
      aria-hidden
      data-v2-success-ripple="1"
      style={{
        position: "absolute",
        top: y,
        left: x,
        width: SIZE_PX,
        height: SIZE_PX,
        border: `2px solid ${color}`,
        borderRadius: "50%",
        pointerEvents: "none",
        zIndex: 9050,
        transform: "translate(-50%, -50%) scale(0.1)",
        opacity: 0.6,
        animation: `v2-success-ripple ${DURATION_MS}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`,
      }}
    />,
    document.body,
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}
