/**
 * Vitest stub for Next.js's `server-only` package.
 *
 * The real `server-only` throws at module-load time if it's bundled into a
 * client component — that's how Next.js prevents server-only code from
 * leaking to the browser. Vitest runs in Node so the barrier doesn't apply,
 * but the module's exception still trips test loaders. This empty stub
 * lets transitive imports succeed.
 */
export {};
