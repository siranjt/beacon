/**
 * Phase E-15.3b — tests for the SQL statement splitter.
 *
 * The runner depends on this being correct. A misclassified BEGIN/COMMIT
 * would nest a transaction inside `sql.transaction()`. A misclassified
 * inline comment would corrupt statement text. Lock both down.
 */

import { describe, it, expect } from "vitest";
import { splitStatements } from "./sql-split.mjs";

describe("splitStatements — basic cases", () => {
  it("returns an empty array for empty input", () => {
    expect(splitStatements("")).toEqual([]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(splitStatements("   \n  \n\n")).toEqual([]);
  });

  it("splits a single statement with trailing semicolon", () => {
    expect(splitStatements("SELECT 1;\n")).toEqual(["SELECT 1"]);
  });

  it("splits multiple statements separated by ;\\n", () => {
    expect(
      splitStatements("SELECT 1;\nSELECT 2;\nSELECT 3;\n"),
    ).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  it("handles statement without trailing newline before EOF", () => {
    expect(splitStatements("SELECT 1;")).toEqual(["SELECT 1"]);
  });
});

describe("splitStatements — comment stripping", () => {
  it("strips line comments before splitting", () => {
    const sql = `-- header comment
SELECT 1; -- trailing comment
SELECT 2;
`;
    expect(splitStatements(sql)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("does not get tripped by --; inside a comment", () => {
    // A `--;` would falsely terminate the statement if we didn't strip
    // comments first. This regression-tests that case.
    const sql = `SELECT 1; -- this has a --; in it
SELECT 2;
`;
    expect(splitStatements(sql)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("strips full-line comments leaving no empty statement chunks", () => {
    const sql = `-- only a comment
-- and another
SELECT 1;
`;
    expect(splitStatements(sql)).toEqual(["SELECT 1"]);
  });
});

describe("splitStatements — BEGIN/COMMIT/END filtering", () => {
  // Critical: our migration runner wraps each file in sql.transaction(),
  // so an explicit BEGIN/COMMIT in the SQL would nest a transaction and
  // 500. The splitter drops them.
  it("drops a bare BEGIN statement", () => {
    expect(splitStatements("BEGIN;\nSELECT 1;\nCOMMIT;\n")).toEqual([
      "SELECT 1",
    ]);
  });

  it("drops END as a transaction-control alias", () => {
    expect(splitStatements("BEGIN;\nSELECT 1;\nEND;\n")).toEqual(["SELECT 1"]);
  });

  it("filtering is case-insensitive", () => {
    expect(splitStatements("begin;\nSELECT 1;\ncommit;\n")).toEqual([
      "SELECT 1",
    ]);
  });

  it("does NOT drop CREATE TABLE statements that happen to contain the word BEGIN", () => {
    // Edge case: a column named "begin_date" or a comment about "BEGIN"
    // should NOT be stripped. Only standalone BEGIN; statements are.
    const sql = `CREATE TABLE foo (begin_date DATE);
`;
    expect(splitStatements(sql)).toEqual([
      "CREATE TABLE foo (begin_date DATE)",
    ]);
  });
});

describe("splitStatements — realistic Beacon migration patterns", () => {
  it("handles a CREATE TABLE + CREATE INDEX pair (E-9 umbrella-activity shape)", () => {
    const sql = `-- migration header
CREATE TABLE IF NOT EXISTS am_activity_log (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_am_activity_log_email ON am_activity_log (email);
`;
    const parts = splitStatements(sql);
    expect(parts.length).toBe(2);
    expect(parts[0]).toMatch(/CREATE TABLE IF NOT EXISTS am_activity_log/);
    expect(parts[1]).toMatch(/CREATE INDEX IF NOT EXISTS idx_am_activity_log_email/);
  });

  it("handles a migration wrapped in BEGIN/COMMIT (e.g. 2026-05-22-beacon-ai-memory)", () => {
    const sql = `BEGIN;

CREATE TABLE IF NOT EXISTS beacon_ai_conversations (
  id BIGSERIAL PRIMARY KEY
);

CREATE INDEX IF NOT EXISTS idx_x ON beacon_ai_conversations (id);

COMMIT;
`;
    const parts = splitStatements(sql);
    // BEGIN + COMMIT dropped, two DDL statements remain.
    expect(parts.length).toBe(2);
    expect(parts[0]).toMatch(/CREATE TABLE/);
    expect(parts[1]).toMatch(/CREATE INDEX/);
  });

  it("handles ALTER TABLE + multiple CREATE INDEX (E-12 shape)", () => {
    const sql = `ALTER TABLE beacon_ai_user_facts ADD COLUMN IF NOT EXISTS scope_key TEXT;
CREATE INDEX IF NOT EXISTS i1 ON beacon_ai_user_facts (email, scope_key);
CREATE INDEX IF NOT EXISTS i2 ON beacon_ai_user_facts (email);
CREATE INDEX IF NOT EXISTS i3 ON beacon_ai_user_facts (scope_key);
`;
    const parts = splitStatements(sql);
    expect(parts.length).toBe(4);
  });
});
