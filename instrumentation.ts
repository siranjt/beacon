/**
 * Next.js 14 instrumentation hook. Phase E-9.
 *
 * Called once when the Next.js server boots. Delegates to the right
 * Sentry config based on the runtime (Node.js vs Edge). Sentry's
 * @sentry/nextjs setup uses this hook to wire up server-side captures
 * automatically.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
