"use client";
import { useEffect, useRef } from "react";

type Options = {
  maxTilt?: number;       // degrees, default 3
  perspective?: number;   // px, default 1000
  liftPx?: number;        // px lift on hover, default 2
};

/**
 * Phase 22.E — 3D parallax tilt on hover. The element tilts toward the
 * cursor up to `maxTilt` degrees and lifts `liftPx` toward the viewer.
 * Folds the lift into the JS transform so CSS :hover and JS-set
 * transforms don't fight each other. Replaces useMagnetic on KpiTile
 * (the two effects conflicted on the selected tile).
 */
export function useTilt<T extends HTMLElement>(opts: Options = {}) {
  const { maxTilt = 3, perspective = 1000, liftPx = 2 } = opts;
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf: number | null = null;

    function onMove(e: MouseEvent) {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const px = (x / rect.width) - 0.5;
      const py = (y / rect.height) - 0.5;
      const rotY = px * maxTilt * 2;
      const rotX = -py * maxTilt * 2;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (el) el.style.transform = `translateY(-${liftPx}px) perspective(${perspective}px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg)`;
      });
    }

    function onLeave() {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (el) el.style.transform = "";
      });
    }

    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el?.removeEventListener("mousemove", onMove);
      el?.removeEventListener("mouseleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
      if (el) el.style.transform = "";
    };
  }, [maxTilt, perspective, liftPx]);

  return ref;
}
