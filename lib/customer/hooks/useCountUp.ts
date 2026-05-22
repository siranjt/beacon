import { useEffect, useState, useRef } from "react";

type Options = {
  duration?: number; // ms, default 900
  start?: number; // default 0
  decimals?: number; // default 0
  enabled?: boolean; // default true
};

/**
 * Animates a number from `start` to `target` over `duration` ms with cubic
 * ease-out. Returns the current animated value. Re-animates whenever
 * `target` changes (smooth morph between values).
 *
 * Phase 22.A — foundation animations. Used by AnimatedNumber and any
 * downstream consumer that wants tabular-num counter behavior.
 */
export function useCountUp(target: number, opts: Options = {}): number {
  const { duration = 900, start = 0, decimals = 0, enabled = true } = opts;
  const [value, setValue] = useState<number>(enabled ? start : target);
  const rafRef = useRef<number | null>(null);
  const startValRef = useRef<number>(start);

  useEffect(() => {
    if (!enabled) {
      setValue(target);
      return;
    }
    if (!Number.isFinite(target)) {
      setValue(0);
      return;
    }
    startValRef.current = value;
    const startTime = performance.now();
    const from = startValRef.current;
    const diff = target - from;
    function frame(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = from + diff * eased;
      setValue(next);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        setValue(target);
      }
    }
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration, enabled]);

  return Number(value.toFixed(decimals));
}
