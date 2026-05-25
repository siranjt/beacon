/**
 * SQL statement splitter — Phase E-15.3b.
 *
 * Extracted from scripts/migrate.mjs so it can be imported by a vitest suite.
 * The migration runner depends on this being correct: a misclassified
 * statement could nest a BEGIN inside our sql.transaction() wrapper and 500
 * the entire migration.
 *
 * Rule: a statement ends at `;` followed by newline (or end of file). Line
 * comments (`-- …`) are stripped first so an embedded `--;` doesn't trip
 * the splitter. After splitting, raw BEGIN/COMMIT/END tokens are dropped —
 * we wrap each migration file in our own sql.transaction() and a nested
 * transaction control statement would conflict.
 *
 * Limitations (acknowledged): no PL/pgSQL $$ quoting support, no string
 * literal with embedded `;` support. Our migrations don't use either. If
 * we add PL/pgSQL functions someday, this needs a proper SQL lexer.
 */

export function splitStatements(sqlText) {
  // Strip line comments first so a `--;` doesn't trip the splitter.
  const stripped = sqlText
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");

  // Split on `;` at end of line.
  const parts = stripped.split(/;\s*(?:\n|$)/);
  return parts
    .map((s) => s.trim())
    // Drop empty chunks AND raw BEGIN/COMMIT/END tokens — we wrap each
    // migration in our own sql.transaction() and a nested BEGIN/COMMIT would
    // 500. Legacy migrations had explicit BEGIN; / COMMIT; that were
    // appropriate for psql but conflict with neon's transaction API.
    .filter((s) => s.length > 0 && !/^(BEGIN|COMMIT|END)\s*$/i.test(s));
}
