"use client";

import { useEffect, useId, useRef, useState } from "react";

type Props = {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fillColor?: string;
  /** Render a vertical gradient from color (top) to transparent (bottom) below the line */
  gradient?: boolean;
  label?: string;
  min?: number;
  max?: number;
  showLastPoint?: boolean;
  showLastValue?: boolean;
  formatLastValue?: (n: number) => string;
  referenceValue?: number | null;
  referenceColor?: string;
  className?: string;
};

export default function V2Sparkline({
  values,
  width = 80,
  height = 24,
  color = "currentColor",
  fillColor,
  gradient = false,
  label,
  min,
  max,
  showLastPoint = true,
  showLastValue = false,
  formatLastValue,
  referenceValue,
  referenceColor = "rgba(11,5,29,0.18)",
  className,
}: Props) {
  const gradId = useId();
  const lineRef = useRef<SVGPathElement | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [pathLength, setPathLength] = useState<number | null>(null);

  useEffect(() => {
    // Measure the actual rendered path length so the dash math is exact
    // (falls back to a generous 1000 if getTotalLength is unavailable).
    if (lineRef.current && typeof lineRef.current.getTotalLength === "function") {
      try {
        const len = lineRef.current.getTotalLength();
        if (Number.isFinite(len) && len > 0) setPathLength(len);
      } catch {
        /* ignore — falls back to default dasharray below */
      }
    }
    const t = setTimeout(() => setDrawn(true), 50);
    return () => clearTimeout(t);
  }, [])

  // Filter NaN/non-finite values to prevent SVG path corruption
  const safeValues = values.filter((v) => Number.isFinite(v));
  if (!safeValues.length) {
    return (
      <span
        className={`inline-block text-[10px] text-zoca-text-3 ${className || ""}`}
        aria-label="No trend data"
      >
        —
      </span>
    );
  }

  const lo = min !== undefined ? min : Math.min(...safeValues);
  const hi = max !== undefined ? max : Math.max(...safeValues);
  const range = hi - lo || 1;
  const step = safeValues.length > 1 ? width / (safeValues.length - 1) : 0;

  const pts = safeValues.map((v, i) => {
    const x = i * step;
    const y = height - ((v - lo) / range) * height;
    return { x, y };
  });

  const linePath = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");

  const effectiveFill = gradient
    ? `url(#${gradId})`
    : fillColor || null;

  const fillPath = effectiveFill
    ? `M0,${height} ${pts.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} L${pts[pts.length - 1].x.toFixed(1)},${height} Z`
    : null;

  const last = pts[pts.length - 1];

  const refY =
    referenceValue !== null && referenceValue !== undefined
      ? height - ((referenceValue - lo) / range) * height
      : null;

  const lastVal = safeValues[safeValues.length - 1];

  return (
    <span className={`inline-flex items-center gap-1 ${className || ""}`}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={
          label ||
          `Sparkline of ${safeValues.length} values, last value ${lastVal}`
        }
      >
        {gradient && (
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
        )}
        {fillPath && (
          // Phase 33.brand-PR4 entry fade + PR4b breathe loop (spec §8 row 3)
          <path
            d={fillPath}
            fill={effectiveFill || "transparent"}
            className={drawn ? "b-area-breathe" : undefined}
            style={{
              opacity: drawn ? 0.55 : 0,
              transition: "opacity 0.6s ease 0.9s",
            }}
          />
        )}
        {refY !== null && (
          <line
            x1={0}
            x2={width}
            y1={refY}
            y2={refY}
            stroke={referenceColor}
            strokeWidth={0.75}
            strokeDasharray="2 2"
          />
        )}
        <path
          ref={lineRef}
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: pathLength != null ? `${pathLength}` : "1000",
            strokeDashoffset: drawn ? 0 : pathLength != null ? pathLength : 1000,
            // Phase 33.brand-PR4 — slower, more cinematic line draw (spec §8: 2.0s)
            transition: "stroke-dashoffset 1.8s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        />
        {showLastPoint && drawn && (
          // Phase 33.brand-PR4b — halo ripple expanding outward from the spike (spec §8 row 5)
          <circle
            cx={last.x}
            cy={last.y}
            fill={color}
            className="b-spike-halo"
          />
        )}
        {showLastPoint && (
          // Phase 33.brand-PR4 entry grow + PR4b infinite pulse (spec §8 row 4)
          <circle
            cx={last.x}
            cy={last.y}
            r={drawn ? 1.8 : 0}
            fill={color}
            className={drawn ? "b-spike-pulse" : undefined}
            style={{
              transition: "r 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) 1.2s",
            }}
          />
        )}
      </svg>
      {showLastValue && (
        <span
          className="text-[10px] font-medium tabular-nums text-zoca-text-2"
          aria-hidden
        >
          {formatLastValue ? formatLastValue(lastVal) : lastVal}
        </span>
      )}
    </span>
  );
}
