/**
 * Sentry — server-side (Node.js runtime) initialization. Phase E-9.
 *
 * Loaded automatically by @sentry/nextjs for API routes and server
 * components running on the Node.js runtime. Captures unhandled
 * exceptions in route handlers + server actions + RSC renders.
 *
 * Defensive — if SENTRY_DSN isn't set in the env, init() is a no-op.
 */

import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    environment: process.env.VERCEL_ENV ?? "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? undefined,
    // Don't capture errors from health-check / cron probes — they're noisy
    // and not actionable.
    ignoreErrors: [],
    beforeSend(event: Sentry.ErrorEvent, _hint: Sentry.EventHint) {
      // Strip auth headers from any captured request — Bearer tokens, session
      // cookies, anything sensitive.
      if (event.request?.headers) {
        for (const k of Object.keys(event.request.headers)) {
          const lower = k.toLowerCase();
          if (
            lower === "authorization" ||
            lower === "cookie" ||
            lower === "x-vercel-cron-signature" ||
            lower.startsWith("x-zoca-")
          ) {
            event.request.headers[k] = "[Filtered]";
          }
        }
      }
      // Strip the question/draft content from /api/ai/ask error reports —
      // customer data could be in there.
      if (event.request?.url?.includes("/api/ai/")) {
        if (event.request.data) {
          event.request.data = "[Filtered — Beacon AI body redacted]";
        }
      }
      return event;
    },
  });
}
