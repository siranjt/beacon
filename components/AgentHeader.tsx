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

function relativeAge(generatedAt: string | null | undefined): string {
  if (!generatedAt) return "—";
  const ms = Date.now() - Date.parse(generatedAt);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

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

      {/* Right — live status + user menu (admin/manager/AM pill + sign-out) */}
      <div className="flex items-center gap-3 flex-wrap">
        <div
          className="flex items-center gap-2 text-[11px] text-zoca-text-2"
          style={{ transition: "font-size 0.2s ease" }}
        >
          {/* Same outward-ping live dot used by V2Header. */}
          <span className="b-status-ping zoca-pulse-dot-green" />
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {generatedAt ? `Live · ${relativeAge(generatedAt)}` : status}
          </span>
        </div>

        <V2UserMenu />
      </div>
    </nav>
  );
}
