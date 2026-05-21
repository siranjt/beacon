'use client';

import { useEffect, useRef } from 'react';

const COLORS = ['#EC4899', '#8B5CF6', '#F59E0B', '#10B981', '#2D5BFF'];

/**
 * Floating colored particles drifting up from the bottom of the host element.
 * Place this once at the top level of a relatively-positioned container.
 */
export default function AmbientSparkles({
  intervalMs = 1800,
  maxConcurrent = 12,
}: {
  intervalMs?: number;
  maxConcurrent?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let alive = true;

    function spawn() {
      if (!alive || !host) return;
      if (host.childElementCount >= maxConcurrent) return;
      const el = document.createElement('div');
      el.className = 'ambient-spark';
      el.style.background = COLORS[Math.floor(Math.random() * COLORS.length)];
      el.style.left = Math.random() * host.offsetWidth + 'px';
      el.style.bottom = '0px';
      host.appendChild(el);
      window.setTimeout(() => el.remove(), 2100);
    }

    const id = window.setInterval(spawn, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [intervalMs, maxConcurrent]);

  return (
    <div
      ref={ref}
      aria-hidden
      className="absolute inset-0 pointer-events-none overflow-hidden"
      style={{ zIndex: 0 }}
    />
  );
}
