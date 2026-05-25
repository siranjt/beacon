"use client";

/**
 * Floating "Compare N customers" bar — Phase E-14.
 *
 * Pinned to the bottom of V2Dashboard when ≥2 customers are selected via
 * the per-card checkbox UX (or the cmd+K palette). Shows the picks, lets
 * the user remove individual ones, and provides a single Compare button
 * that navigates to /compare?entities=…
 *
 * Only renders when the viewer is manager/admin (the cross-AM role). AMs
 * don't see it — but they also don't see the checkboxes, so they won't
 * have selections in the first place. Belt-and-braces.
 */

import { useRouter } from "next/navigation";
import { useCompareSelection } from "@/lib/customer/hooks/use-compare-selection";
import type { ScoredCustomerV2 } from "@/lib/customer/types";

const C = {
  text: "#2B1F14",
  textInv: "#F0E4CC",
  parchment: "#F0E4CC",
  brass: "#D9A441",
  brassDark: "#8B5E10",
  border: "rgba(43, 31, 20, 0.16)",
  lapis: "#2A4D5C",
} as const;

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = "-apple-system, Inter, system-ui, sans-serif";

interface Props {
  /** Whether the current viewer is allowed to use compare (manager or admin). */
  enabled: boolean;
  /** All customers in the snapshot so we can resolve entity_id → biz name in the bar. */
  customers: ScoredCustomerV2[];
}

export default function V2CompareBar({ enabled, customers }: Props) {
  const router = useRouter();
  const { selected, count, remove, clear, max } = useCompareSelection();

  if (!enabled) return null;
  if (count === 0) return null;

  const byEntity = new Map(customers.map((c) => [c.entity_id, c]));

  return (
    <div
      role="region"
      aria-label="Customer comparison selection"
      style={{
        position: "fixed",
        bottom: 18,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 50,
        background: C.parchment,
        border: `2px solid ${C.lapis}`,
        borderRadius: 14,
        padding: "10px 14px",
        display: "flex",
        gap: 12,
        alignItems: "center",
        fontFamily: SANS,
        color: C.text,
        boxShadow: "0 6px 24px rgba(43, 31, 20, 0.22)",
        maxWidth: "92vw",
        flexWrap: "wrap",
      }}
    >
      <div
        style={{
          fontFamily: SERIF,
          fontSize: 13,
          fontWeight: 600,
          color: C.text,
          letterSpacing: "-0.005em",
          paddingRight: 8,
          borderRight: `1px solid ${C.border}`,
        }}
      >
        Comparing {count} / {max}
      </div>

      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {selected.map((id) => {
          const c = byEntity.get(id);
          const label = c?.company || id.slice(0, 8);
          return (
            <span
              key={id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px",
                background: "rgba(42, 77, 92, 0.10)",
                border: `1px solid rgba(42, 77, 92, 0.30)`,
                borderRadius: 8,
                fontSize: 12,
              }}
            >
              {label}
              <button
                type="button"
                onClick={() => remove(id)}
                aria-label={`Remove ${label} from comparison`}
                title="Remove"
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: C.text,
                  fontSize: 14,
                  lineHeight: 1,
                  padding: 0,
                  marginLeft: 2,
                }}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          marginLeft: 8,
          paddingLeft: 8,
          borderLeft: `1px solid ${C.border}`,
        }}
      >
        <button
          type="button"
          onClick={() => clear()}
          style={{
            padding: "6px 10px",
            background: "transparent",
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            fontSize: 11,
            cursor: "pointer",
            color: C.text,
            fontWeight: 500,
          }}
        >
          Clear
        </button>
        <button
          type="button"
          disabled={count < 2}
          onClick={() => {
            const q = encodeURIComponent(selected.join(","));
            router.push(`/compare?entities=${q}`);
          }}
          style={{
            padding: "6px 14px",
            background: count < 2 ? "#9CA3AF" : C.lapis,
            color: C.textInv,
            border: "none",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.04em",
            cursor: count < 2 ? "not-allowed" : "pointer",
            textTransform: "uppercase",
          }}
          title={
            count < 2
              ? "Select at least 2 customers to compare"
              : `Compare ${count} customers`
          }
        >
          Compare →
        </button>
      </div>
    </div>
  );
}
