"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (2 hex/rgba + 0 tailwind-rose swept)

import * as React from "react";
import { createPortal } from "react-dom";

type TourStep = {
  selector: string;
  title: string;
  body: string;
};

type Props = {
  /** When true, force the tour to render regardless of localStorage. */
  forceOpen?: boolean;
  /** Fires after the user finishes / skips so the parent can clean up. */
  onClose?: () => void;
};

const STORAGE_KEY = "zoca_v2_onboarding_complete";

const STEPS: TourStep[] = [
  {
    selector: "[data-tour-target='step1']",
    title: "Signal chips",
    body:
      "These chips tell you the active risk signals at a glance. Click any chip to filter your book to just that signal.",
  },
  {
    selector: "[data-tour-target='step2']",
    title: "One-line narrative",
    body:
      "Each customer has a one-line explanation of why they're in this tier. The crimson/pink/amber/emerald tint matches the four-tier health model (Critical / At-risk / Monitor / Healthy).",
  },
  {
    selector: "[data-tour-target='step3']",
    title: "Primary action",
    body:
      "This is the suggested next move. Click it to log how the call went — connected, voicemail, or no reach.",
  },
  {
    selector: "[data-tour-target='step4']",
    title: "Snooze menu",
    body:
      "Snooze any customer to hide them from your triage view for 1-30 days. They'll automatically reappear when the snooze elapses.",
  },
  {
    selector: "[data-tour-target='step5']",
    title: "Open detail",
    body:
      "The ↗ link opens the full customer page with action log, comms thread, performance, and tickets. Or use keyboard shortcut → from any card.",
  },
];

type Rect = { top: number; left: number; width: number; height: number };

const TOOLTIP_WIDTH = 320;
const TOOLTIP_HEIGHT_ESTIMATE = 160;
const GAP = 12;
const PAD = 4;

/**
 * Phase 32 — V2OnboardingTour.
 *
 * 5-step first-run walkthrough. Renders a darkened backdrop with a "hole"
 * over the highlighted element (4 rectangles around it) and a tooltip card
 * positioned next to it. localStorage gates re-runs; ?force-tour=1 bypasses.
 *
 * Targets are found by `data-tour-target` attributes on the FIRST visible
 * customer card. If no card is found, the tour does nothing this visit.
 */
export default function V2OnboardingTour({ forceOpen, onClose }: Props) {
  const [mounted, setMounted] = React.useState(false);
  const [stepIndex, setStepIndex] = React.useState(0);
  const [active, setActive] = React.useState(false);
  const [targetRect, setTargetRect] = React.useState<Rect | null>(null);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Decide once on mount whether to run.
  React.useEffect(() => {
    if (!mounted) return;
    if (typeof window === "undefined") return;
    let forceTour = forceOpen ?? false;
    if (!forceTour) {
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.get("force-tour") === "1") {
          forceTour = true;
        }
      } catch {
        /* ignore */
      }
    }
    const done = (() => {
      try {
        return window.localStorage.getItem(STORAGE_KEY) === "1";
      } catch {
        return false;
      }
    })();
    if (!forceTour && done) return;
    // Ensure at least one customer card has tour targets.
    const firstTarget = document.querySelector(STEPS[0]?.selector ?? "");
    if (!firstTarget) return;
    setActive(true);
  }, [mounted, forceOpen]);

  // Recompute target rect whenever step changes.
  React.useLayoutEffect(() => {
    if (!active) return;
    function measure() {
      const step = STEPS[stepIndex];
      if (!step) return;
      const el = document.querySelector(step.selector);
      if (!el) {
        setTargetRect(null);
        return;
      }
      const r = (el as HTMLElement).getBoundingClientRect();
      setTargetRect({
        top: r.top + window.scrollY,
        left: r.left + window.scrollX,
        width: r.width,
        height: r.height,
      });
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, stepIndex]);

  React.useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") finish(false);
      if (e.key === "Enter" || e.key === "ArrowRight") {
        if (stepIndex < STEPS.length - 1) setStepIndex((i) => i + 1);
        else finish(true);
      }
      if (e.key === "ArrowLeft" && stepIndex > 0) setStepIndex((i) => i - 1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stepIndex]);

  function finish(saveCompleted: boolean) {
    if (saveCompleted) {
      try {
        window.localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    setActive(false);
    onClose?.();
  }

  if (!mounted || !active) return null;

  const step = STEPS[stepIndex];
  if (!step) return null;
  const isLast = stepIndex === STEPS.length - 1;

  // Compute tooltip position relative to target rect.
  const tooltipPos = (() => {
    if (!targetRect) {
      return {
        top: Math.max(window.scrollY + 100, 100),
        left: Math.max(8, (window.innerWidth - TOOLTIP_WIDTH) / 2),
      };
    }
    // Prefer below; fall back above if no space.
    const spaceBelow = window.innerHeight - (targetRect.top - window.scrollY + targetRect.height);
    const placeBelow = spaceBelow > TOOLTIP_HEIGHT_ESTIMATE + GAP + 20;
    const top = placeBelow
      ? targetRect.top + targetRect.height + GAP
      : Math.max(window.scrollY + 8, targetRect.top - TOOLTIP_HEIGHT_ESTIMATE - GAP);
    const idealLeft = targetRect.left + targetRect.width / 2 - TOOLTIP_WIDTH / 2;
    const left = Math.max(
      window.scrollX + 8,
      Math.min(window.scrollX + window.innerWidth - TOOLTIP_WIDTH - 8, idealLeft),
    );
    return { top, left };
  })();

  return createPortal(
    <div
      role="dialog"
      aria-label={`Onboarding tour — step ${stepIndex + 1} of ${STEPS.length}`}
      data-v2-onboarding-tour="1"
      style={{ position: "absolute", inset: 0, zIndex: 9500, pointerEvents: "none" }}
    >
      {/* Backdrop: 4 rectangles around the target (or full overlay if no target). */}
      {targetRect ? (
        <BackdropWithHole rect={targetRect} />
      ) : (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(11, 5, 29, 0.55)",
            pointerEvents: "auto",
          }}
        />
      )}

      {/* Outline around target */}
      {targetRect && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: targetRect.top - PAD,
            left: targetRect.left - PAD,
            width: targetRect.width + PAD * 2,
            height: targetRect.height + PAD * 2,
            borderRadius: "12px",
            border: "2px solid rgba(200, 67, 29, 0.85)",
            boxShadow: "0 0 0 4px rgba(200, 67, 29, 0.18)",
            pointerEvents: "none",
            zIndex: 9501,
          }}
        />
      )}

      {/* Tooltip card */}
      <div
        className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft"
        style={{
          position: "absolute",
          top: tooltipPos.top,
          left: tooltipPos.left,
          width: TOOLTIP_WIDTH,
          padding: "16px 18px",
          boxShadow: "0 12px 32px rgba(11,5,29,0.18)",
          pointerEvents: "auto",
          zIndex: 9502,
        }}
      >
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[14px] font-semibold leading-tight text-zoca-text">
            {step.title}
          </h3>
          <span className="text-[10px] font-medium uppercase tracking-wider text-zoca-text-3">
            Step {stepIndex + 1} of {STEPS.length}
          </span>
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-zoca-text-2">{step.body}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => finish(true)}
            className="text-[11px] text-zoca-text-2 underline-offset-2 hover:text-zoca-text hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
            aria-label="Skip tour"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <button
                type="button"
                onClick={() => setStepIndex((i) => i - 1)}
                className="rounded-zoca-pill px-3 py-1.5 text-[11px] font-medium text-zoca-text-2 hover:bg-zoca-bg-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
                aria-label="Previous step"
              >
                ← Back
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (isLast) finish(true);
                else setStepIndex((i) => i + 1);
              }}
              className="rounded-zoca-pill bg-zoca-pink-cta px-3.5 py-1.5 text-[11px] font-semibold text-white shadow-zoca-sm transition hover:shadow-zoca-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
              aria-label={isLast ? "Finish tour" : "Next step"}
            >
              {isLast ? "Got it" : "Next →"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function BackdropWithHole({ rect }: { rect: Rect }) {
  const styles: React.CSSProperties = {
    position: "absolute",
    background: "rgba(11, 5, 29, 0.55)",
    pointerEvents: "auto",
  };
  // Compute rects relative to document.
  const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
  const top: React.CSSProperties = {
    ...styles,
    top: 0,
    left: 0,
    width: docW,
    height: Math.max(0, rect.top - PAD),
  };
  const bottom: React.CSSProperties = {
    ...styles,
    top: rect.top + rect.height + PAD,
    left: 0,
    width: docW,
    height: Math.max(0, docH - (rect.top + rect.height + PAD)),
  };
  const left: React.CSSProperties = {
    ...styles,
    top: rect.top - PAD,
    left: 0,
    width: Math.max(0, rect.left - PAD),
    height: rect.height + PAD * 2,
  };
  const right: React.CSSProperties = {
    ...styles,
    top: rect.top - PAD,
    left: rect.left + rect.width + PAD,
    width: Math.max(0, docW - (rect.left + rect.width + PAD)),
    height: rect.height + PAD * 2,
  };
  return (
    <>
      <div aria-hidden style={top} />
      <div aria-hidden style={bottom} />
      <div aria-hidden style={left} />
      <div aria-hidden style={right} />
    </>
  );
}
