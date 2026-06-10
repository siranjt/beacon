/**
 * V2ShadowVerdictChip — SV-10.
 *
 * Small "AI says" pill that surfaces the latest LLM shadow-verdict tier next
 * to the engine's stoplight on each V2CustomerCard. Renders nothing when no
 * shadow_verdict row exists for the entity (early days of shadow window, LLM
 * run failed, or the table isn't populated yet).
 *
 * Visual contract:
 *   • 22px tall pill with "AI" label + dot in the SV-tier color
 *   • when SV tier disagrees with the engine's stoplight, a "≠" glyph is
 *     appended and the pill border darkens so the disagreement is visible
 *     at a glance without animation (reduced-motion safe — no pulse)
 *   • title attribute carries the primary_driver + run_date for context
 *
 * Reuses the same tier-color tokens the StoplightDot uses inside
 * V2CustomerCard.tsx, so the SV chip and engine dot read off the same
 * palette and stay in sync if those tokens ever move.
 */

import type { Stoplight } from "@/lib/customer/config";

type SvTier = "RED" | "YELLOW" | "GREEN";

interface Props {
  shadowVerdict: {
    tier: SvTier;
    run_date: string;
    primary_driver?:
      | "billing"
      | "comms"
      | "performance"
      | "tickets"
      | "sentiment"
      | "mixed";
  };
  engineStoplight: Stoplight;
}

const SV_COLOR: Record<SvTier, string> = {
  RED: "#ef4444",
  YELLOW: "#f59e0b",
  GREEN: "#10b981",
};

const TIER_LABEL: Record<SvTier, string> = {
  RED: "Red",
  YELLOW: "Yellow",
  GREEN: "Green",
};

const DRIVER_LABEL: Record<NonNullable<Props["shadowVerdict"]["primary_driver"]>, string> = {
  billing: "billing",
  comms: "comms",
  performance: "performance",
  tickets: "tickets",
  sentiment: "sentiment",
  mixed: "mixed signals",
};

export default function V2ShadowVerdictChip({
  shadowVerdict,
  engineStoplight,
}: Props): React.JSX.Element {
  const svTier = shadowVerdict.tier;
  const dotColor = SV_COLOR[svTier];
  const disagrees = svTier !== engineStoplight;

  const driverText = shadowVerdict.primary_driver
    ? DRIVER_LABEL[shadowVerdict.primary_driver]
    : null;

  const title = disagrees
    ? `Beacon AI says ${TIER_LABEL[svTier]} — disagrees with the engine's ${TIER_LABEL[engineStoplight as SvTier] ?? engineStoplight}. ` +
      `Primary driver: ${driverText ?? "—"}. Verdict from ${shadowVerdict.run_date}.`
    : `Beacon AI agrees: ${TIER_LABEL[svTier]}. ` +
      `Primary driver: ${driverText ?? "—"}. Verdict from ${shadowVerdict.run_date}.`;

  return (
    <span
      role="status"
      aria-label={title}
      title={title}
      className="inline-flex items-center gap-1 rounded-zoca-pill px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
      style={{
        height: 22,
        background: disagrees
          ? "rgba(45, 72, 67, 0.10)"
          : "rgba(45, 72, 67, 0.06)",
        border: `1px solid ${disagrees ? dotColor : "rgba(45, 72, 67, 0.18)"}`,
        color: "#2d4843",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: dotColor,
          boxShadow: `0 0 6px ${dotColor}`,
        }}
      />
      <span style={{ letterSpacing: "0.04em" }}>AI</span>
      {disagrees && (
        <span
          aria-hidden
          title="Beacon AI disagrees with the engine's stoplight"
          style={{
            marginLeft: 1,
            fontWeight: 700,
            color: dotColor,
            lineHeight: 1,
          }}
        >
          ≠
        </span>
      )}
    </span>
  );
}
