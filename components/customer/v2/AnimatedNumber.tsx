"use client";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { useCountUp } from "@/lib/customer/hooks/useCountUp";

type Props = {
  value: number;
  duration?: number;
  format?: (n: number) => string;
  className?: string;
  style?: React.CSSProperties;
};

/**
 * Phase 22.A — drop-in animated number. Uses tabular-nums by default so
 * digits don't shift horizontally while the count climbs. Optional
 * `format` lets callers render currency / percentages / abbreviated K-M.
 *
 * Phase 22.E — when the target value changes by >10%, briefly pulse text
 * color to brand pink. Makes AM switches feel responsive.
 */
export function AnimatedNumber({
  value,
  // Phase 33.brand-watchfire-PR8-42 — 800ms ease-out per spec §11 row 42.
  duration = 800,
  format,
  className,
  style,
}: Props) {
  const animated = useCountUp(value, { duration });
  const display = format ? format(animated) : animated.toLocaleString();
  const [flash, setFlash] = useState(false);
  const prevValueRef = useRef(value);

  useEffect(() => {
    const prev = prevValueRef.current;
    if (prev > 0 && Math.abs(value - prev) / Math.max(prev, 1) > 0.1) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 300);
      prevValueRef.current = value;
      return () => clearTimeout(t);
    }
    prevValueRef.current = value;
  }, [value]);

  return (
    <span
      className={className}
      style={{
        fontVariantNumeric: "tabular-nums",
        transition: "color 0.3s ease",
        color: flash ? "var(--zoca-pink)" : undefined,
        ...style,
      }}
    >
      {display}
    </span>
  );
}

export default AnimatedNumber;
