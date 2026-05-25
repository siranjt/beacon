/**
 * Sentry — Edge runtime initialization. Phase E-9.
 *
 * Loaded by @sentry/nextjs for any code paths running on Vercel Edge
 * (middleware, edge-runtime route handlers). Beacon mostly uses the
 * Node.js runtime, but the umbrella's NextAuth middleware and any future
 * edge routes get covered here too.
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
  });
}
