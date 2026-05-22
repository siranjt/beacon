"use client";

type Props = {
  width?: string | number;
  height?: string | number;
  variant?: "text" | "rect" | "circle" | "card";
  className?: string;
  style?: React.CSSProperties;
};

/**
 * Shimmer skeleton placeholder. Used during the snapshot-fetch boot in
 * V2Dashboard so the user sees structure instead of a blank pulse.
 */
export function Skeleton({ width = "100%", height = "14px", variant = "rect", className, style }: Props) {
  const w = typeof width === "number" ? `${width}px` : width;
  const h = typeof height === "number" ? `${height}px` : height;
  const radius = variant === "circle" ? "50%" : variant === "card" ? "14px" : variant === "text" ? "4px" : "8px";
  return (
    <div
      className={`v2-skeleton ${className ?? ""}`}
      style={{ width: w, height: h, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}

export function CustomerCardSkeleton() {
  return (
    <div className="v2-skeleton-card-wrap" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            padding: "20px 22px",
            background: "var(--zoca-bg-soft)",
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: "14px",
            animationDelay: `${i * 60}ms`,
          }}
          className="zoca-fade-in"
        >
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <Skeleton variant="circle" width={10} height={10} />
            <Skeleton width="40%" height={18} variant="text" />
            <Skeleton width={60} height={20} variant="rect" />
          </div>
          <Skeleton width="80%" height={14} variant="text" />
          <Skeleton width="60%" height={14} variant="text" />
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
