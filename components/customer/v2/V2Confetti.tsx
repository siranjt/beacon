"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (2 hex/rgba + 0 tailwind-rose swept)

import * as React from "react";
import { createPortal } from "react-dom";

type Props = {
  x: number;
  y: number;
  onDone?: () => void;
};

const PARTICLE_COUNT = 40;
const DURATION_MS = 1500;
const COLORS = ["#C8431D", "#146ef5", "#10b981", "#f59e0b"];

type Particle = {
  id: number;
  color: string;
  vx: number;
  vy: number;
  rotation: number;
  size: number;
};

/**
 * Phase 32 — V2Confetti.
 *
 * 40 tiny rectangles fly outward from (x, y), arc under gravity, and fade
 * over 1.5s. Pure DOM + CSS — no canvas, no external lib.
 *
 * Respects prefers-reduced-motion (renders nothing).
 */
export default function V2Confetti({ x, y, onDone }: Props) {
  const [mounted, setMounted] = React.useState(false);
  const reduced = useReducedMotion();

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const particles = React.useMemo<Particle[]>(() => {
    if (reduced) return [];
    return Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      id: i,
      color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? "#C8431D",
      vx: randBetween(-150, 150),
      vy: randBetween(-400, -200),
      rotation: Math.random() * 360,
      size: 6,
    }));
  }, [reduced]);

  React.useEffect(() => {
    if (!onDone) return;
    if (reduced) {
      // Fire onDone immediately so the parent cleans up without animation.
      const id = window.setTimeout(onDone, 50);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(onDone, DURATION_MS + 100);
    return () => window.clearTimeout(id);
  }, [onDone, reduced]);

  if (!mounted || reduced) return null;

  return createPortal(
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: y,
        left: x,
        width: 0,
        height: 0,
        pointerEvents: "none",
        zIndex: 9100,
      }}
      data-v2-confetti="1"
    >
      {particles.map((p) => {
        const destX = p.vx * 1.5;
        const destY = p.vy * 1.5 + 600;
        const style: React.CSSProperties = {
          position: "absolute",
          top: 0,
          left: 0,
          width: p.size,
          height: p.size,
          background: p.color,
          borderRadius: "1px",
          // Custom CSS vars consumed by the keyframe.
          ["--vx" as string]: `${destX}px`,
          ["--vy" as string]: `${destY}px`,
          ["--rot" as string]: `${p.rotation + 720}deg`,
          animation: `v2-confetti-fly ${DURATION_MS}ms cubic-bezier(0.15, 0.5, 0.4, 1) forwards`,
          opacity: 1,
        };
        return <span key={p.id} style={style} />;
      })}
    </div>,
    document.body,
  );
}

function randBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
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
