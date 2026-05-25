"use client";

/**
 * AgentHeader — the umbrella's standard top chrome.
 *
 * Lifted from Customer Beacon's V2Header (the v1-promoted gold standard
 * register) and generalized so Performance / Escalation / Post-Payment can
 * reuse it. Same sticky parchment bar, same brand lockup, same admin pill
 * avatar on the right.
 *
 * Customer-specific bits NOT lifted (intentionally):
 *   - AM picker pill (V2Header.tsx: requires session.user.am_name + an
 *     allAms list; AM/Manager-scoped concept that doesn't exist for the
 *     other agents)
 *   - "AM's view / Manager's view" tab toggle (same — there is no peer
 *     view in Performance/Escalation/Post-Payment)
 *
 * What the other agents DO get:
 *   - ZOCA wordmark | divider | animated Beacon flame | "Beacon · <agent>"
 *   - Optional right-side status text + tabular-nums live-relative
 *     timestamp + V2UserMenu (avatar dropdown with role pill + sign out)
 *
 * Usage:
 *   <AgentHeader agentName="Performance" status="Live" />
 *   <AgentHeader agentName="Escalation" generatedAt={iso} />
 *   <AgentHeader agentName="Post-Payment" />
 */

import { BeaconMark } from "./BeaconMark";
import ZocaLogo from "./ZocaLogo";
import { V2UserMenu } from "./customer/v2/V2UserMenu";
import FreshnessIndicator from "./FreshnessIndicator";

type AgentHeaderProps = {
  /** Agent name appended to "Beacon · " in the lockup. */
  agentName: string;
  /**
   * ISO timestamp of when current data was generated. When supplied, the
   * right-side status renders "Live · 3 min ago". When omitted, "status"
   * text is used instead (or "Live" by default).
   */
  generatedAt?: string | null;
  /** Override the right-side status text. Defaults to "Live". */
  status?: string;
  /**
   * Optional href for the brand-lockup anchor. Defaults to "/" so clicking
   * the wordmark returns to the umbrella launcher.
   */
  homeHref?: string;
};

export default function AgentHeader({
  agentName,
  generatedAt,
  status = "Live",
  homeHref = "/",
}: AgentHeaderProps) {
  return (
    <nav
      className="sticky top-0 z-20 flex items-center justify-between px-6 py-3 border-b backdrop-blur-md flex-wrap gap-3"
      style={{
        // Same Parchment + backdrop-blur as V2Header so the Customer Beacon
        // and other agents read as one unified app at the top edge.
        background: "rgba(240, 228, 204, 0.92)",
        borderColor: "var(--zoca-border)",
        transition: "padding 0.2s ease, box-shadow 0.2s ease",
      }}
    >
      {/* Left — branding lockup (ZOCA + divider + flame + Beacon · <agent>) */}
      <a
        href={homeHref}
        className="flex items-center gap-3 no-underline"
        aria-label="Zoca Beacon home"
      >
        <ZocaLogo height={20} fill="var(--zoca-text)" />
        <span className="text-zoca-text-3 text-xs">|</span>
        <BeaconMark size={20} flicker />
        <span
          className="text-zoca-text text-[13px] font-medium"
          style={{ letterSpacing: "-0.005em" }}
        >
          Beacon{agentName ? ` · ${agentName}` : ""}
        </span>
      </a>

      {/* Right — Cmd+K hint chip, live status / freshness, user menu */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Phase E-9 — discovery chip for the global command palette.
            Hidden on small viewports where it would crowd the header. */}
        <CmdKHint />

        <div
          className="flex items-center gap-2 text-[11px] text-zoca-text-2"
          style={{ transition: "font-size 0.2s ease" }}
        >
          {generatedAt ? (
            <FreshnessIndicator
              ts={generatedAt}
              source={`${agentName} · live data`}
              compact
            />
          ) : (
            <>
              <span className="b-status-ping zoca-pulse-dot-green" />
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{status}</span>
            </>
          )}
        </div>

        <V2UserMenu />
      </div>
    </nav>
  );
}

/* Small "⌘K" affordance chip — clickable, dispatches a synthetic Cmd+K
   keydown so the existing CommandPaletteProvider handler opens the
   palette. Avoids leaking a React Context just for the open() call. */
function CmdKHint() {
  return (
    <button
      type="button"
      aria-label="Open command palette (⌘K)"
      onClick={() => {
        if (typeof window === "undefined") return;
        // Dispatch the same kind of event the CommandPaletteProvider listens
        // for. Modifier flag matches what real browsers send on Cmd+K (Mac).
        const isMac = navigator.platform.toLowerCase().includes("mac");
        const evt = new KeyboardEvent("keydown", {
          key: "k",
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(evt);
      }}
      className="hidden sm:inline-flex items-center gap-1 text-[10px] text-zoca-text-2"
      style={{
        background: "var(--zoca-surface, #F8EFD7)",
        border: "1px solid var(--zoca-border, #D4C29B)",
        borderRadius: 6,
        padding: "2px 8px",
        cursor: "pointer",
        fontFamily: "-apple-system, Inter, system-ui, sans-serif",
        letterSpacing: "0.04em",
      }}
    >
      <kbd
        style={{
          fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
          fontWeight: 600,
        }}
      >
        ⌘K
      </kbd>
      <span style={{ opacity: 0.7 }}>jump</span>
    </button>
  );
}
