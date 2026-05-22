"use client";

import type { ScoredCustomerV2 } from "@/lib/customer/types";
import { normalizeHealthTier } from "@/lib/customer/config";

type Props = {
  amName: string;
  customers: ScoredCustomerV2[];
  onDismiss: () => void;
};

export default function V2WelcomeStrip({ amName, customers, onDismiss }: Props) {
  // Phase 33.scope followup — exclude recently_churned from welcome-strip tallies.
  // The lifecycle pill on the card already surfaces them separately;
  // counting them here doubles them into the "needs a call" stack.
  const _activeCustomers = customers.filter(
    (c) => (c as any).lifecycle_state !== "recently_churned",
  );
  const redCount = _activeCustomers.filter((c) => c.signals_v2.stoplight === "RED").length;
  const yellowCount = _activeCustomers.filter((c) => c.signals_v2.stoplight === "YELLOW").length;
  // Phase 33.H.2 — tier-based counts (MONITOR fallback for missing metabase_health)
  // Phase Beacon-fix — robust tier classification with stoplight fallback
  function _classify(c: ScoredCustomerV2): "needsCall" | "watching" | "healthy" {
    const ht = normalizeHealthTier((c as any).metabase_health?.health_tier);
    if (ht === "CRITICAL" || ht === "AT-RISK") return "needsCall";
    if (ht === "HEALTHY") return "healthy";
    if (ht === "MONITOR") return "watching";
    // Fallback: no metabase_health row — use legacy stoplight
    if (c.signals_v2?.stoplight === "RED") return "needsCall";
    if (c.signals_v2?.stoplight === "GREEN") return "healthy";
    return "watching";
  }
  const needsCallCount = _activeCustomers.filter((c) => _classify(c) === "needsCall").length;
  const watchingCount = _activeCustomers.filter((c) => _classify(c) === "watching").length;
  const total = _activeCustomers.length;

  // Phase 33.brand-watchfire-T13 — Welcome strip rewired to Watchfire tokens.
  // Old text-zoca-text-primary/text-zoca-text-muted classes don't exist in the
  // Tailwind config — they were resolving to no color so the strip read as
  // nearly-invisible peach text on the banner gradient.
  return (
    <div className="my-5 flex flex-wrap items-center justify-between gap-3 rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft px-5 py-4">
      <div className="text-sm text-zoca-text">
        <strong>Welcome back{amName ? `, ${firstName(amName)}` : ""}.</strong>{" "}
        <span className="text-zoca-text-2">
          {total === 0
            ? "No customers in your book yet."
            : needsCallCount === 0 && watchingCount === 0
              ? `${total} customers in your book — all doing fine right now.`
              : `${needsCallCount} need a call, ${watchingCount} to watch${
                  total > 0 ? `, out of ${total} in your book.` : "."
                }`}
        </span>
      </div>
      <button
        onClick={onDismiss}
        className="rounded-zoca-pill border border-zoca-border px-3 py-1.5 text-[12px] text-zoca-text-2 transition hover:bg-zoca-bg-tint/60 hover:text-zoca-text hover:border-zoca-border-2"
      >
        Got it
      </button>
    </div>
  );
}

function firstName(am: string): string {
  return am.split(" ")[0] || am;
}
