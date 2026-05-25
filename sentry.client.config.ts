/**
 * Sentry — browser-side initialization. Phase E-9.
 *
 * Loaded automatically by @sentry/nextjs for client bundles. Captures
 * unhandled errors, unhandled promise rejections, and explicit Sentry
 * captures (Sentry.captureException(err)).
 *
 * Defensive — if SENTRY_DSN isn't set in the env, init() is a no-op and
 * we still build/run normally. The DSN is exposed via NEXT_PUBLIC_SENTRY_DSN
 * so the client bundle can read it.
 *
 * Sample rates:
 *   - errors: 100% (we want to see every crash)
 *   - traces: 10% (perf monitoring — capped to keep cost down)
 *   - replays on error: 100% (debug the exact UI state when it broke)
 *   - replays in normal sessions: 0% (no privacy cost / no quota burn)
 */

import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0,
    // Don't leak Beacon AI conversation content or customer notes through
    // breadcrumbs in error reports.
    sendDefaultPii: false,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
    // Surface the deploy SHA so issues land grouped per release.
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? undefined,
    // Browser-only integrations.
    integrations: [
      Sentry.replayIntegration({
        // Mask all text by default — Beacon shows customer data, AM names,
        // and AI conversation transcripts that shouldn't end up in Sentry's
        // session replay UI. Devs can selectively unmask known-safe elements
        // with `data-sentry-unmask` if needed.
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],
    // Quiet known harmless noise. Add to this list as we identify others.
    ignoreErrors: [
      // Browsers fire ResizeObserver loop errors that don't represent bugs.
      "ResizeObserver loop completed with undelivered notifications",
      "ResizeObserver loop limit exceeded",
      // Network aborts during navigation are expected, not errors.
      "AbortError",
      "Network request failed",
    ],
  });
}
