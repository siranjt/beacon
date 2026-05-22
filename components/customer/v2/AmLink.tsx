"use client";
import { useRouter } from "next/navigation";

type Props = {
  amName: string;
  filter?: "act" | "improving" | "quiet" | "all" | "pinned" | "snoozed";
  children?: React.ReactNode;
  showArrow?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

export function AmLink({ amName, filter, children, showArrow = true, className, style }: Props) {
  const router = useRouter();
  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const params = new URLSearchParams();
    params.set("am", amName);
    if (filter) params.set("filter", filter);
    router.push(`/customer?${params.toString()}`);
  }
  return (
    <button
      onClick={handleClick}
      className={className}
      style={{
        background: "transparent",
        border: 0,
        padding: 0,
        font: "inherit",
        color: "inherit",
        cursor: "pointer",
        textDecoration: "none",
        display: "inline-flex",
        alignItems: "baseline",
        gap: "3px",
        transition: "color 0.18s ease",
        ...style,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--zoca-blue)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = ""; }}
      title={`Switch to ${amName}'s Beacon`}
    >
      {children ?? amName}
      {showArrow && <span style={{ fontSize: "0.78em", opacity: 0.6 }}>↗</span>}
    </button>
  );
}
