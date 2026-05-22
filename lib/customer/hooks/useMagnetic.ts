"use client";
import { useEffect, useRef } from "react";

type Options = {
  strength?: number;      // 0-1, default 0.2 (subtle pull)
  radius?: number;        // px, default 60 (proximity zone)
};

/**
 * Magnetic effect: the element follows the cursor within `radius` pixels
 * by `strength` ratio. Returns a ref to attach to the element.
 *
 * Phase 22.D — applied to primary action buttons only to keep the effect
 * subtle and unobtrusive (V2RefreshBar refresh, V2KpiTiles selected tile,
 * V2CustomerCard log-contact CTA, SavedViewsRow save-current-view).
 */
export function useMagnetic<T extends HTMLElement>(opts: Options = {}) {
  const { strength = 0.25, radius = 70 } = opts;
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let rafId: number | null = null;

    function onMove(e: MouseEvent) {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius * 2) {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          if (el) el.style.transform = "";
        });
        return;
      }
      const proximityFactor = Math.max(0, 1 - dist / (radius * 1.5));
      const tx = dx * strength * proximityFactor;
      const ty = dy * strength * proximityFactor;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (el) el.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)`;
      });
    }

    function onLeave() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (el) el.style.transform = "";
      });
    }

    document.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      document.removeEventListener("mousemove", onMove);
      el?.removeEventListener("mouseleave", onLeave);
      if (rafId) cancelAnimationFrame(rafId);
      if (el) el.style.transform = "";
    };
  }, [strength, radius]);

  return ref;
}
