/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
    // Phase E-9 — required by @sentry/nextjs so the instrumentation.ts
    // hook fires on server boot.
    instrumentationHook: true,
  },
};

// Phase E-9 — Sentry integration.
// Wraps the config so source maps get uploaded on build and errors route
// to Sentry. Sentry's wrapper is defensive: when SENTRY_AUTH_TOKEN or
// SENTRY_DSN aren't set, the build still succeeds — it just skips the
// source-map upload + no errors get sent. Local dev works without Sentry
// configured at all.
//
// Required env vars in production (Vercel):
//   SENTRY_DSN              (server-side error reporting)
//   NEXT_PUBLIC_SENTRY_DSN  (browser-side error reporting; same value as SENTRY_DSN)
//   SENTRY_ORG              (e.g. "zoca")
//   SENTRY_PROJECT          (e.g. "beacon")
//   SENTRY_AUTH_TOKEN       (optional, for source-map uploads — better stack traces)
let exportedConfig = nextConfig;
try {
  // Lazy require — if @sentry/nextjs isn't installed (e.g. in a fresh
  // checkout before `npm install`), the build still works.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { withSentryConfig } = require("@sentry/nextjs");
  exportedConfig = withSentryConfig(nextConfig, {
    silent: true,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    widenClientFileUpload: true,
    hideSourceMaps: true,
    disableLogger: true,
    automaticVercelMonitors: false,
  });
} catch (e) {
  // @sentry/nextjs not installed yet — fall back to bare nextConfig.
  // eslint-disable-next-line no-console
  console.warn(
    "[next.config] @sentry/nextjs not available, skipping wrapper:",
    e && e.message,
  );
}

module.exports = exportedConfig;
