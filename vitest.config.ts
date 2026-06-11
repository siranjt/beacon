/**
 * Vitest config — Phase E-13.
 *
 * Node environment by default (most of our unit-testable code is server
 * lib/ pure functions). If/when we add component tests, we'll opt those
 * suites into a jsdom environment via a per-test `// @vitest-environment`
 * pragma — keeps the default fast.
 *
 * Path alias: the only alias the repo uses is `@/*` → repo root. We inline
 * it here instead of pulling in `vite-tsconfig-paths` because that plugin
 * is ESM-only and our repo is CommonJS — incompatible with vite's config
 * loader. Inlining is one line of code and avoids the dep entirely.
 */

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
      // OPT-2 — stub Next.js's `server-only` package for vitest. The barrier
      // is enforced at build time by Next; vitest doesn't load it. Without
      // this alias, any test that transitively imports a `server-only`
      // module fails. Empty-module shim is safe — production code paths
      // still respect the build-time check.
      "server-only": resolve(__dirname, "tests/_stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: [
      "tests/**/*.test.{ts,tsx}",
      "lib/**/*.test.{ts,tsx}",
      "scripts/**/*.test.{ts,tsx}",
      "components/**/*.test.{ts,tsx}",
    ],
    // Exclude the Next.js build output and anything in node_modules.
    exclude: ["node_modules", ".next", "dist", "out"],
    globals: false,
    // Keep our suites tight — most Beacon AI tests will be sub-second.
    // 10s is a safety net for the (rare) integration-style test that
    // talks to a real local Postgres.
    testTimeout: 10_000,
    reporters: process.env.CI ? ["default", "github-actions"] : ["default"],
  },
});
