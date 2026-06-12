"use client";

/**
 * BeamThinkingPill — Direction-C-aware in-flight loader.
 *
 * Replaces the bare gray "Fetching the details…" pill in ActionCard
 * (2026-06-13 polish pass). Two lanes:
 *
 *   - Keeper-touching tools (read_customer_brain, query_brain,
 *     add_fact_to_brain) render with the KeeperVault glyph and a
 *     dial that spins ember-into-brass for 1.6s. Same vault that
 *     ships on every KeeperChip — the loader doubles as a brand
 *     reinforcement moment, "Beam is reaching into the Keeper".
 *
 *   - Everything else renders the BeaconMark with flicker on. Tower
 *     stays static, flame flickers — same 4-layer mark we use in
 *     the topnav, just sized down to 14px tall.
 *
 * Pill background stays brass-tinted (matches the previous trailer
 * style) so the in-flight pill is visually consistent with the
 * post-result pill that lands a moment later.
 *
 * Tool → label + lane mapping lives in lib/ai/tool-thinking-states.ts.
 * To add a new tool, add an entry there — this component picks it up
 * automatically.
 */

import { BeaconMark } from "@/components/BeaconMark";
import { getBeamThinkingState } from "@/lib/ai/tool-thinking-states";

const SANS = "-apple-system, Inter, system-ui, sans-serif";

interface Props {
  toolName?: string | null;
  /**
   * Optional label override — when the parent already knows the tool
   * is in a sub-step (e.g. a draft continuation that's actually still
   * processing), it can pass a custom label. Falls back to the
   * tool-name lookup otherwise.
   */
  labelOverride?: string | null;
}

export default function BeamThinkingPill({ toolName, labelOverride }: Props) {
  const state = getBeamThinkingState(toolName);
  const label = labelOverride ?? state.label;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        alignSelf: "flex-start",
        maxWidth: "92%",
        padding: "7px 12px",
        fontSize: 12.5,
        color: "#3c2412",
        fontFamily: SANS,
        background: "rgba(217, 164, 65, 0.10)",
        border: "1px solid rgba(217, 164, 65, 0.45)",
        borderRadius: 999,
        display: "inline-flex",
        alignItems: "center",
        gap: 9,
        lineHeight: 1.2,
      }}
    >
      {state.kind === "vault" ? <SpinningVault /> : <BeaconMark size={16} flicker />}
      <span style={{ fontWeight: 500 }}>{label}</span>
      <BeamThinkingPillStyles />
    </div>
  );
}

/**
 * KeeperVault glyph with the inner dial in motion. Same brass body +
 * ember dial palette as the static chip glyph, but the dial group
 * gets a 1.6s `spin` rotation so the loading state is visible at a
 * glance. Tick marks stay static — they're the visual stator the
 * dial spins inside.
 *
 * SVG inline rather than re-importing KeeperVault because that
 * component renders a static glyph by design; the spin lives only
 * here in the loading surface.
 */
function SpinningVault() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0, display: "inline-block", verticalAlign: "-3px" }}
    >
      <rect
        x="2"
        y="3"
        width="16"
        height="14"
        rx="2"
        stroke="#D9A441"
        strokeWidth={1.6}
      />
      <line x1="10" y1="6.5" x2="10" y2="5" stroke="#D9A441" strokeWidth={1.6} strokeLinecap="round" />
      <line x1="10" y1="15" x2="10" y2="13.5" stroke="#D9A441" strokeWidth={1.6} strokeLinecap="round" />
      <line x1="6.5" y1="10" x2="5" y2="10" stroke="#D9A441" strokeWidth={1.6} strokeLinecap="round" />
      <line x1="15" y1="10" x2="13.5" y2="10" stroke="#D9A441" strokeWidth={1.6} strokeLinecap="round" />
      <g className="beam-vault-dial" style={{ transformOrigin: "10px 10px" }}>
        <circle cx="10" cy="10" r="3.5" stroke="#C8431D" strokeWidth={1.6} fill="none" />
        <circle cx="10" cy="6.5" r="0.85" fill="#C8431D" />
      </g>
    </svg>
  );
}

/**
 * Keyframe + reduced-motion guard. Co-located so any consumer that
 * pulls in BeamThinkingPill gets the styles automatically — no global
 * stylesheet entry needed.
 */
function BeamThinkingPillStyles() {
  return (
    <style>{`
      @keyframes beam-vault-spin {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
      }
      .beam-vault-dial {
        animation: beam-vault-spin 1.6s linear infinite;
        transform-box: fill-box;
      }
      @media (prefers-reduced-motion: reduce) {
        .beam-vault-dial { animation: none; }
      }
    `}</style>
  );
}
