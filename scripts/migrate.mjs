#!/usr/bin/env node
/**
 * Beacon migration runner — Phase E-15.2.
 *
 * Tracks applied migrations in `schema_migrations(filename, applied_at)` and
 * runs anything new in /migrations alpha order. Replaces "user remembers to
 * paste SQL into the Neon console" — which we already shipped E-12 without
 * for half a day.
 *
 * Run locally:
 *   POSTGRES_URL='postgres://…' npm run migrate
 *
 * On Vercel:
 *   wired via `vercel-build` script in package.json so it auto-runs before
 *   `next build` on every deploy. Set POSTGRES_URL in Vercel env vars.
 *
 * Design choices:
 *   - Each migration runs inside one transaction so partial-apply failures
 *     don't leave the DB in a half-state.
 *   - Skip-by-default if POSTGRES_URL isn't set, so local `npm run build`
 *     without env vars doesn't error out.
 *   - Statements within a .sql file are split by `;` at the end of a line
 *     and run one-by-one — this matches what the Neon SQL Editor expects
 *     (multi-statement scripts aren't supported by the prepared-statement
 *     driver). It's a simple split that handles our migrations correctly;
 *     anything fancier (CTEs with embedded ;, PL/pgSQL DO blocks) would
 *     need a real SQL lexer.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
// Phase E-15.3b — extracted so vitest can cover it independently.
import { splitStatements } from "./lib/sql-split.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "..", "migrations");

const POSTGRES_URL = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
if (!POSTGRES_URL) {
  console.warn(
    "[migrate] POSTGRES_URL not set — skipping migrations. " +
      "If this is a Vercel build, add POSTGRES_URL to env vars.",
  );
  process.exit(0);
}

const sql = neon(POSTGRES_URL);

async function ensureMigrationsTable() {
  await sql(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INTEGER
    )
  `);
}

async function appliedSet() {
  const rows = await sql(`SELECT filename FROM schema_migrations`);
  return new Set(rows.map((r) => r.filename));
}

async function runMigration(filename, fullPath) {
  const sqlText = readFileSync(fullPath, "utf8");
  const statements = splitStatements(sqlText);
  if (statements.length === 0) {
    console.warn(`[migrate]   ${filename}: no statements found, marking applied anyway`);
  }
  const started = Date.now();
  // Neon's HTTP driver doesn't expose explicit BEGIN/COMMIT in the same way
  // node-postgres does, but it does support `sql.transaction([…])` for atomic
  // multi-statement runs. We use that for each migration file.
  await sql.transaction([
    ...statements.map((s) => sql(s)),
    sql(
      `INSERT INTO schema_migrations (filename, duration_ms) VALUES ($1, $2)`,
      [filename, Date.now() - started],
    ),
  ]);
  console.log(`[migrate]   ✓ ${filename} (${statements.length} stmts, ${Date.now() - started}ms)`);
}

async function main() {
  console.log("[migrate] connecting to", POSTGRES_URL.replace(/:[^:@/]+@/, ":****@"));

  await ensureMigrationsTable();
  const applied = await appliedSet();
  const allFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // YYYY-MM-DD-… prefix means alpha sort = chronological

  const pending = allFiles.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(`[migrate] up to date — ${applied.size} migration(s) applied previously`);
    return;
  }

  console.log(
    `[migrate] running ${pending.length} pending migration(s):\n  ${pending.join("\n  ")}`,
  );

  for (const filename of pending) {
    const fullPath = resolve(MIGRATIONS_DIR, filename);
    try {
      await runMigration(filename, fullPath);
    } catch (err) {
      console.error(`[migrate] ✗ ${filename} FAILED:`, err?.message ?? err);
      console.error(
        "[migrate] migration aborted. Fix the SQL or remove the file from /migrations and re-run.",
      );
      process.exit(1);
    }
  }

  console.log(`[migrate] done — ${pending.length} migration(s) applied`);
}

main().catch((err) => {
  console.error("[migrate] fatal:", err?.message ?? err);
  process.exit(1);
});
