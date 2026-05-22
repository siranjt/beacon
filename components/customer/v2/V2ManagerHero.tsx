"use client";
import { ZocaSparkle } from "./ZocaSparkle";
import { formatManagerTitle } from "@/lib/customer/format";

type Props = {
  redCount?: number;
  customerCount?: number;
  amCount?: number;
  podCount?: number;
};

/**
 * Phase 17.D — Manager hero. Same beats as V2Hero (chip + gradient h1 +
 * sparkles + subtitle + asterisk callouts) but worded for the rollup view.
 */
export function V2ManagerHero({
  redCount,
  customerCount,
  amCount,
  podCount,
}: Props) {
  const title = formatManagerTitle();
  const needsCall = redCount ?? 0;
  const totalCount = customerCount ?? 921;
  const ams = amCount ?? 13;
  const pods = podCount ?? 5;
  return (
    <section
      className="zoca-fade-in text-center px-6"
      style={{ paddingTop: "44px", paddingBottom: "24px" }}
    >
      {/* Chip — block-level wrapper so it stacks above the h1 */}
      <div className="mb-5 flex justify-center">
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full"
          style={{
            border: "1px solid rgba(200, 67, 29, 0.18)",
            background: "rgba(200, 67, 29, 0.06)",
          }}
        >
          <span className="zoca-pulse-dot-green" />
          <span
            className="text-[11px] font-semibold uppercase text-zoca-blue"
            style={{ letterSpacing: "0.08em" }}
          >
            Team health · updated hourly
          </span>
        </div>
      </div>

      {/* Title — gradient h1 with positioned sparkle accents */}
      <div>
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
          <span className="beacon-hero-entry zoca-gradient-text" style={{ display: "inline-block" }}>{title}</span>
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
          maxWidth: "560px",
          fontSize: "14px",
          lineHeight: 1.6,
          letterSpacing: "-0.005em",
        }}
      >
        {needsCall > 0
          ? `Cross-AM and cross-pod rollup. ${needsCall} customer${needsCall === 1 ? "" : "s"} need a call today — click a pod card to filter the rollup, or a heatmap cell to drill into a pod-signal pair.`
          : "Cross-AM and cross-pod view of customer health. Click a pod card to filter the rollup, or a heatmap cell to drill into a pod-signal pair."}
      </p>
      <div className="inline-flex items-center gap-6 mt-5 flex-wrap justify-center text-[12px] font-medium text-zoca-text-2">
        <span className="inline-flex items-center gap-2">
          <span className="text-zoca-pink" style={{ fontSize: "12px", lineHeight: 1 }}>{"❋"}</span> {ams} AMs
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="text-zoca-pink" style={{ fontSize: "12px", lineHeight: 1 }}>{"❋"}</span> {pods} pods
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="text-zoca-pink" style={{ fontSize: "12px", lineHeight: 1 }}>{"❋"}</span> {totalCount} active customers
        </span>
      </div>
    </section>
  );
}

export default V2ManagerHero;
