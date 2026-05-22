"use client";
import { ZocaSparkle } from "./ZocaSparkle";
import { AnimatedNumber } from "./AnimatedNumber";
import { formatPlannerTitle } from "@/lib/customer/format";

type Props = {
  amName?: string | null;
  redCount?: number;
  customerCount?: number;
};

export function V2Hero({ amName, redCount, customerCount }: Props) {
  const title = formatPlannerTitle(amName);
  const needsCall = redCount ?? 0;
  const totalCount = customerCount ?? 921;
  return (
    <section
      className="zoca-fade-in text-center px-6"
      style={{ paddingTop: "44px", paddingBottom: "24px" }}
    >
      {/* Chip — wrapped in a block-level container so it stacks ABOVE the h1
          instead of sitting next to it on the same baseline. */}
      <div className="mb-5 flex justify-center">
        <div
          className="beacon-pill-fade inline-flex items-center gap-2 px-4 py-1.5 rounded-full"
          // Phase 33.brand-watchfire-audit-T2 — Sea Lapis tones replace V2 blue tint.
          style={{
            border: "1px solid rgba(42, 77, 92, 0.22)",
            background: "rgba(42, 77, 92, 0.06)",
          }}
        >
          <span className="zoca-pulse-dot-green" />
          <span
            className="text-[11px] font-semibold uppercase"
            style={{ letterSpacing: "0.08em", color: "#2A4D5C" }}
          >
            Live customer signals · auto-scored by Claude
          </span>
        </div>
      </div>

      {/* Title — wrapped in a block-level container so the gradient h1 with its
          absolutely-positioned sparkles centers cleanly under the chip. */}
      <div className="beacon-hero-entry">
        <h1
          className="m-0 font-extrabold"
          style={{
            fontSize: "clamp(40px, 6vw, 64px)",
            lineHeight: 1.02,
            letterSpacing: "-0.035em",
            position: "relative",
            display: "inline-block",
          }}
        >
          <ZocaSparkle
            size={18}
            style={{ position: "absolute", top: "-8px", left: "-26px" }}
          />
          <span className="zoca-gradient-text">{title}</span>
          <ZocaSparkle
            size={14}
            delay={1}
            style={{
              position: "absolute",
              top: "-2px",
              right: "-30px",
              color: "var(--zoca-blue)",
            }}
          />
          <ZocaSparkle
            size={11}
            delay={2}
            style={{ position: "absolute", bottom: "2px", right: "-14px" }}
          />
        </h1>
      </div>

      <p
        className="mx-auto mt-4 mb-0 text-zoca-text-2"
        style={{
          maxWidth: "520px",
          fontSize: "14px",
          lineHeight: 1.6,
          letterSpacing: "-0.005em",
        }}
      >
        {needsCall > 0 ? (
          <>
            <span style={{ fontVariantNumeric: "tabular-nums" }}><AnimatedNumber value={needsCall} duration={900} /></span> customers need your attention today — surfaced from live billing, comms, app usage, and HubSpot signals.
          </>
        ) : (
          "Quiet today — no signals worth following right now. Use the filters below to review the full book."
        )}
      </p>
      <div className="inline-flex items-center gap-6 mt-5 flex-wrap justify-center text-[12px] font-medium text-zoca-text-2">
        <span className="beacon-stats-dot inline-flex items-center gap-2">
          <span className="text-zoca-pink" style={{ fontSize: "12px", lineHeight: 1 }}>{"❋"}</span> <span style={{ fontVariantNumeric: "tabular-nums" }}><AnimatedNumber value={totalCount} duration={900} /></span> active customers
        </span>
        <span className="beacon-stats-dot inline-flex items-center gap-2">
          <span className="text-zoca-pink" style={{ fontSize: "12px", lineHeight: 1 }}>{"❋"}</span> Live Chargebee + Metabase
        </span>
        <span className="beacon-stats-dot inline-flex items-center gap-2">
          <span className="text-zoca-pink" style={{ fontSize: "12px", lineHeight: 1 }}>{"❋"}</span> Claude-scored signals
        </span>
      </div>
    </section>
  );
}

export default V2Hero;
