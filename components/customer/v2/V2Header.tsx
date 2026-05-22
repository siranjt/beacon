"use client";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { ZocaLogo } from "./ZocaLogo";
import { BeaconMark } from "@/components/customer/BeaconMark";
import { AmPickerPill } from "./AmPickerPill";
import { RefreshButton } from "./RefreshButton";
import { V2UserMenu } from "./V2UserMenu";
import { isManagerOrAdmin } from "@/lib/customer/config";
import type { V2View } from "./V2Dashboard";

type AmProps = {
  generatedAt?: string | null;
  mode?: "am";
  selectedAm: string;
  allAms: string[];
  onAmChange: (am: string) => void;
  view: V2View;
  setView: (view: V2View) => void;
};

type ManagerProps = {
  generatedAt?: string | null;
  mode: "manager";
  selectedAm?: never;
  allAms?: never;
  onAmChange?: never;
  view?: never;
  setView?: never;
};

type Props = AmProps | ManagerProps;

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

/**
 * Phase 17.B.1 + 17.C + 17.D + 33.A.6 + 33.B — Consolidated top nav.
 *
 * SINGLE sticky bar holding the entire global chrome.
 *   mode="am":
 *     left:  ZOCA logo + "| Beacon" + AM picker pill
 *            (picker visible for admin OR manager — Phase 33.B)
 *     right: peer-tab toggle (AM's view / Manager's view)
 *            + Live status pill + user menu
 *   mode="manager" (Phase 17.D):
 *     left:  ZOCA logo + "| Beacon · Manager"
 *     right: peer-tab toggle + Refresh button + Live status pill
 *
 * Phase 33.B — the AM picker and the "Manager's view" tab were previously
 * admin-only. Now they're visible to BOTH admin and manager, since manager
 * is also a cross-AM role. AMs (role="am") still see neither.
 */
export function V2Header(props: Props) {
  const { generatedAt, mode } = props;
  const isManager = mode === "manager";
  const { data: session } = useSession();
  // Phase 33.B — admin OR manager users see the AM picker + Manager's view
  // tab. AM-role users are locked to their own book (V2Dashboard handles the
  // data filter; here we just hide the chrome).
  const canSwitchAm = isManagerOrAdmin(session?.user?.role);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    function onScroll() {
      setCompact(window.scrollY > 80);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      className={`beacon-nav-slide sticky top-0 z-20 flex items-center justify-between px-6 py-3 border-b backdrop-blur-md flex-wrap gap-3 ${compact ? "v2-header-compact" : ""}`}
      style={{
        // Phase 33.brand-watchfire-T8 — nav on Parchment with backdrop blur.
        background: "rgba(240, 228, 204, 0.92)",
        borderColor: "var(--zoca-border)",
        transition: "padding 0.2s ease, box-shadow 0.2s ease",
      }}
    >
      {/* Left side — branding + (AM picker for AM mode, page name for manager mode) */}
      <div className="flex items-center gap-3 flex-wrap">
        <a
          href="/customer"
          className="flex items-center gap-3 no-underline"
          aria-label="Zoca Beacon home"
        >
          <ZocaLogo height={20} color="var(--zoca-text)" />
          <span className="text-zoca-text-3 text-xs">|</span>
          {/* Phase 33.brand-PR1 — Beacon mark slotted into the lockup at logo-height. */}
          {/* Phase 33.brand-watchfire-T11 — nav flame blazes (4 co-prime layers). */}
          <BeaconMark size={20} flicker />
          <span
            className="text-zoca-text text-[13px] font-medium"
            style={{ letterSpacing: "-0.005em" }}
          >
            {isManager ? "Beacon · Manager" : "Beacon"}
          </span>
        </a>

        {!isManager && canSwitchAm && (
          <AmPickerPill
            selectedAm={props.selectedAm}
            allAms={props.allAms}
            onChange={props.onAmChange}
          />
        )}
      </div>

      {/* Right side — view tabs / manager link / live status */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Phase 33.A.6 + 33.B — naming simplification:
            • two peer tabs: "AM's view" (/v2) + "Manager's view" (/customer/manager)
            • Manager's view tab visible to admin OR manager
              (Phase 33.B — previously admin-only; now both cross-AM roles)
            • AMs (role="am") see only the "AM's view" tab
        */}
        <div
          className="inline-flex items-center gap-1 p-1 rounded-lg"
          style={{
            background: "var(--zoca-bg-soft)",
            border: "1px solid var(--zoca-border)",
          }}
        >
          <NavTab href="/customer" label="AM's view" active={!isManager} />
          {canSwitchAm && (
            <NavTab href="/customer/manager" label="Manager's view" active={isManager} />
          )}
        </div>

        {isManager && (
          <>
            <RefreshButton />
          </>
        )}

        <div className="v2-header-status flex items-center gap-2 text-[11px] text-zoca-text-2" style={{ transition: "font-size 0.2s ease" }}>
          {/* Phase 33.brand-PR4b — outward ping ring around the live-status dot. */}
          <span className="b-status-ping zoca-pulse-dot-green" />
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            Live · {relativeAge(generatedAt)}
          </span>
        </div>

        {/* Phase 33.A — signed-in user menu (avatar + role badge + sign out) */}
        <V2UserMenu />
      </div>
    </nav>
  );
}

// Phase 33.A.6 — NavTab is the anchor-based replacement for the old ViewTab
// (which was button + onClick). Tabs now drive navigation between /v2 and
// /customer/manager rather than swapping internal view state, since "Pod view"
// and "Leadership" no longer exist as panes within /v2.
function NavTab({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  // Phase 33.brand-watchfire-PR7-35 — ripple keys remount the overlay span
  // each click so the CSS animation restarts from scratch.
  const [rippleKey, setRippleKey] = useState(0);
  const baseStyle = active
    ? {
        background: "var(--zoca-text)",
        color: "#ffffff",
        fontWeight: 600 as const,
        textDecoration: "none" as const,
      }
    : {
        background: "transparent",
        color: "var(--zoca-text-2)",
        fontWeight: 500 as const,
        textDecoration: "none" as const,
      };
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      // Phase 33.brand-PR4b — soft pulse on the active tab.
      className={`px-3 py-1 rounded-md text-[11px] transition${active ? " b-tab-pulse" : ""}`}
      style={{ ...baseStyle, position: "relative", overflow: "hidden" }}
      onClick={() => setRippleKey((k) => k + 1)}
    >
      <span style={{ position: "relative", zIndex: 1 }}>{label}</span>
      {rippleKey > 0 && (
        <span key={rippleKey} className="beacon-tab-ripple" aria-hidden />
      )}
    </a>
  );
}

export default V2Header;
