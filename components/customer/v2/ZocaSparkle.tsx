type Props = {
  size?: number;
  delay?: 0 | 1 | 2;
  className?: string;
  style?: React.CSSProperties;
};

/**
 * Phase 17.A — Zoca brand sparkle decoration. Used around hero titles.
 * Auto-animated via .zoca-sparkle class (3s pulse + rotate loop).
 * delay=0 default, delay=1/2 stagger when placing multiple sparkles.
 */
export function ZocaSparkle({ size = 14, delay = 0, className = "", style }: Props) {
  const delayClass = delay === 1 ? "zoca-sparkle-delay-1" : delay === 2 ? "zoca-sparkle-delay-2" : "";
  return (
    <span
      className={`zoca-sparkle ${delayClass} ${className}`.trim()}
      style={{ fontSize: `${size}px`, ...style }}
      aria-hidden="true"
    >
      ✦
    </span>
  );
}
