"use client";

/**
 * V2Dashboard state components — Phase E-15.4 extraction.
 *
 * These four pure / stateless components were inlined in V2Dashboard.tsx,
 * pushing that file past 870 lines. They're rendering-only — no state,
 * no effects, no business logic — so extracting them is risk-free and
 * brings the parent file under the 600-line target.
 *
 *   V2LoadingSkeleton   — pulses while the snapshot fetch is in flight
 *   V2ErrorState        — shown when /api/v2/snapshot returns 500
 *   V2SelectAmPrompt    — admin/manager hasn't picked an AM yet
 *   V2UnmappedAmState   — AM-role user whose email isn't in BaseSheet
 *
 * Keeping the function bodies + classnames verbatim from the original so
 * the visual + a11y attributes don't change.
 */

import { CustomerCardSkeleton } from "./Skeleton";

// ---------------------------------------------------------------------------
// Loading skeleton — 4 card-shaped placeholders pulse during fetch
// ---------------------------------------------------------------------------
export function V2LoadingSkeleton() {
  return (
    <section className="mt-2" aria-busy="true" aria-live="polite">
      <div className="mb-4 h-9 w-3/4 rounded-zoca-sm v2-skeleton" />
      <div className="mb-5 flex gap-2">
        <div className="h-8 w-44 rounded-zoca-pill v2-skeleton" />
        <div className="h-8 w-28 rounded-zoca-pill v2-skeleton" />
        <div className="h-8 w-60 rounded-zoca-pill v2-skeleton" />
      </div>
      <CustomerCardSkeleton />
    </section>
  );
}

export function V2ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-8 rounded-zoca border border-red-500/30 bg-red-500/10 p-6" role="alert">
      <h2 className="font-display text-lg font-bold text-red-200">Could not load snapshot</h2>
      <p className="mt-2 text-sm text-zoca-text-muted">{message}</p>
      <p className="mt-2 text-xs text-zoca-text-soft">
        If this persists, the daily refresh cron may have failed. Check Vercel logs or
        re-run /api/cron/refresh/compose.
      </p>
      <button
        onClick={onRetry}
        className="mt-4 rounded-zoca-pill bg-zoca-pink-2/20 px-4 py-2 text-sm font-medium text-zoca-pink-2 transition hover:bg-zoca-pink-2/30"
      >
        Retry
      </button>
    </div>
  );
}

export function V2SelectAmPrompt() {
  return (
    <div className="mt-12 rounded-zoca border border-dashed border-zoca-border-2 px-6 py-12 text-center">
      <p className="font-display text-lg font-bold text-zoca-text-primary">
        Select an AM to view their book.
      </p>
      <p className="mt-2 text-sm text-zoca-text-muted">
        Use the dropdown in the top bar to pick yourself or another AM.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 33.A — Empty state for an AM-role user whose Google email didn't
// resolve to a BaseSheet entry. Friendly nudge; no data shown.
// ---------------------------------------------------------------------------
export function V2UnmappedAmState() {
  return (
    <div
      className="mt-12 rounded-zoca border border-dashed border-zoca-border-2 px-6 py-12 text-center"
      role="status"
    >
      <p className="font-display text-lg font-bold text-zoca-text-primary">
        Your account isn&rsquo;t mapped to an AM yet.
      </p>
      <p className="mt-2 text-sm text-zoca-text-muted">
        We couldn&rsquo;t match your Google email to a BaseSheet record. Ask
        your manager to add you to the AM list, then sign out and back in.
      </p>
    </div>
  );
}
