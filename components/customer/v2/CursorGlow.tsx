"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (2 hex/rgba + 0 tailwind-rose swept)
import { useEffect, useRef } from "react";

/**
 * Phase 22.E — 400px pink soft-blob that lags the cursor at 6%/frame.
 * mix-blend-mode: multiply keeps it atmospheric over the light theme.
 * Rendered once at the V2Dashboard root behind page content (z-index 0).
 */
export function CursorGlow() {
  const blobRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const blob = blobRef.current;
    if (!blob) return;

    let mouseX = window.innerWidth / 2;
    let mouseY = window.innerHeight / 2;
    let blobX = mouseX;
    let blobY = mouseY;

    function onMove(e: MouseEvent) {
      mouseX = e.clientX;
      mouseY = e.clientY;
    }
    document.addEventListener("mousemove", onMove);

    let raf: number | null = null;
    function tick() {
      blobX += (mouseX - blobX) * 0.06;
      blobY += (mouseY - blobY) * 0.06;
      if (blob) {
        blob.style.transform = `translate(${blobX - 200}px, ${blobY - 200}px)`;
      }
      raf = requestAnimationFrame(tick);
    }
    tick();

    return () => {
      document.removeEventListener("mousemove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={blobRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "400px",
        height: "400px",
        borderRadius: "50%",
        background: "radial-gradient(circle, rgba(124, 45, 18, 0.10) 0%, rgba(124, 45, 18, 0.04) 30%, transparent 70%)",
        pointerEvents: "none",
        zIndex: 0,
        willChange: "transform",
        mixBlendMode: "multiply",
      }}
    />
  );
}

export default CursorGlow;
