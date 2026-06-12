/**
 * WAVE-A-2 — revertSupersession + canRevert tests.
 *
 * The function reads two rows (current fact + most-recent ancestor) and then
 * runs a multi-statement transaction. We mock the SQL tagged-template function
 * with a tiny state machine: SELECTs return canned rows based on which fact
 * the query is targeting, sql.transaction() records the batched writes, and
 * we assert on both the observable outcome and the audit-row contents.
 *
 * DB-touching paths (real Postgres) are exercised by the smoke playbook, not
 * here — same convention as ranking.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrainFact } from "./types";

/* ────────────────────────────────────────────────────────────────────────
 * Stateful SQL mock
 *
 * The mock owns a tiny in-memory store of facts keyed by fact_id. SELECTs
 * route to one of:
 *   - `SELECT * FROM beacon_brain_facts WHERE fact_id = $1` → fetch by id
 *   - `SELECT * FROM beacon_brain_facts WHERE superseded_by = $1` → fetch
 *      most-recent ancestor (we use the store's "supersedes" reverse map)
 *
 * sql.transaction(queries) records every call to `sql\`…\`` made during the
 * test in `txCalls` (a flat list) plus the index of the batch boundary, so
 * tests can assert that the writes landed atomically.
 * ──────────────────────────────────────────────────────────────────────── */

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const sqlCalls: SqlCall[] = [];
const txBatches: SqlCall[][] = [];
// Cursor used by sql.transaction() to know where the WRITE batch starts.
// Bumped to sqlCalls.length after every SELECT (the SELECTs that happen
// before the transaction in revertSupersession).
let txWriteStart = 0;

interface FactRow {
  fact_id: string;
  customer_id: string;
  value: string;
  current_version: number;
  source_type: string;
  source_ref: string | null;
  confidence_state: "confirmed" | "candidate";
  superseded_by: string | null;
  soft_deleted_at: string | null;
  updated_at: string;
}

const factsStore = new Map<string, FactRow>();

function reset() {
  sqlCalls.length = 0;
  txBatches.length = 0;
  txWriteStart = 0;
  factsStore.clear();
}

function makeFact(opts: Partial<FactRow> & { fact_id: string }): FactRow {
  return {
    customer_id: "cust-A",
    value: "value",
    current_version: 1,
    source_type: "manual",
    source_ref: null,
    confidence_state: "confirmed",
    superseded_by: null,
    soft_deleted_at: null,
    updated_at: new Date().toISOString(),
    ...opts,
  };
}

/** Hydrate a FactRow into a full BrainFact for type-compatibility with the
 *  rows we return from the mocked SELECT. revertSupersession() only reads
 *  the columns FactRow carries, so this padding is purely structural. */
function asBrainFact(row: FactRow): BrainFact {
  return {
    ...row,
    topic_category: "identity",
    topic_subcategory: "owner_info",
    field_name: "owner_name",
    value_numeric: null,
    owning_am_email: null,
    confirmed_by_email: null,
    confirmed_at: null,
    sunset_at: null,
    created_at: row.updated_at,
    citation_count: 0,
    last_cited_at: null,
  } as BrainFact;
}

/** Identify which kind of SELECT we're servicing based on the joined SQL
 *  template strings. Keeps the mock independent of whitespace changes.
 *  The `superseded_by =` match deliberately allows an optional table alias
 *  prefix ("loser.superseded_by") so canRevert's query is recognized too. */
function classifySelect(strings: TemplateStringsArray): "by_fact_id" | "by_superseded_by" | "other" {
  const text = strings.join(" ").toLowerCase();
  if (text.includes("from beacon_brain_facts")) {
    if (text.includes("where fact_id =")) return "by_fact_id";
    if (/\bwhere\s+\S*superseded_by\s*=/.test(text)) return "by_superseded_by";
  }
  return "other";
}

/** The Neon-style tagged-template function. Captures every call and routes
 *  SELECTs through the in-memory store. Writes always resolve to []. Updates
 *  `txWriteStart` after each SELECT so the next sql.transaction snapshot
 *  starts at the first WRITE call (the SELECTs aren't part of the tx). */
function sqlFn(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  sqlCalls.push({ strings, values });

  const kind = classifySelect(strings);
  if (kind === "by_fact_id") {
    txWriteStart = sqlCalls.length;
    const target = String(values[0] ?? "");
    const row = factsStore.get(target);
    if (!row || row.soft_deleted_at) return Promise.resolve([]);
    return Promise.resolve([asBrainFact(row)]);
  }
  if (kind === "by_superseded_by") {
    txWriteStart = sqlCalls.length;
    const target = String(values[0] ?? "");
    // Most recent ancestor by updated_at desc.
    const rows = [...factsStore.values()]
      .filter((r) => r.superseded_by === target && !r.soft_deleted_at)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    return Promise.resolve(rows.map(asBrainFact));
  }
  return Promise.resolve([]);
}

// The tagged-template `sql\`…\`` evaluations inside `sql.transaction([…])`
// happen BEFORE the transaction method itself is invoked (JS evaluates
// arguments first), so a `before = sqlCalls.length` snapshot inside
// `transaction()` would always be too late. Instead we update `txWriteStart`
// inside the sql tag (after each SELECT — see sqlFn above) so by the time the
// transaction call runs, txWriteStart already points at the first write.
(sqlFn as unknown as { transaction: (qs: Promise<unknown>[]) => Promise<unknown[]> }).transaction =
  async (qs: Promise<unknown>[]) => {
    const results = await Promise.all(qs);
    txBatches.push(sqlCalls.slice(txWriteStart));
    txWriteStart = sqlCalls.length;
    return results;
  };

vi.mock("../customer/postgres", () => ({
  getSql: () => sqlFn,
}));

beforeEach(() => {
  reset();
});

// Lazy-import after the mock is registered.
async function loadModule() {
  return await import("./revert");
}

/* ────────────────────────────────────────────────────────────────────────
 * Tests
 * ──────────────────────────────────────────────────────────────────────── */

describe("revertSupersession — happy path", () => {
  it("demotes the current fact and promotes the ancestor", async () => {
    const { revertSupersession } = await loadModule();
    const winnerId = "winner-uuid";
    const loserId = "loser-uuid";
    factsStore.set(
      winnerId,
      makeFact({ fact_id: winnerId, superseded_by: null, current_version: 3 }),
    );
    factsStore.set(
      loserId,
      makeFact({ fact_id: loserId, superseded_by: winnerId, current_version: 2 }),
    );

    const result = await revertSupersession(winnerId, "manager@zoca.com", "wrong call");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revertedFromFactId).toBe(winnerId);
    expect(result.revertedToFactId).toBe(loserId);
    expect(result.customerId).toBe("cust-A");

    // The single tx batch contains DEMOTE + PROMOTE + audit + two version rows.
    expect(txBatches).toHaveLength(1);
    const batch = txBatches[0];
    expect(batch.length).toBe(5);

    // DEMOTE: the winner's row gets superseded_by = loserId.
    const demote = batch.find((c) => {
      const t = c.strings.join(" ");
      return t.includes("UPDATE beacon_brain_facts") && t.includes("SET superseded_by =");
    });
    expect(demote).toBeDefined();
    expect(demote?.values).toContain(loserId);

    // Audit row to beacon_brain_revert_log carries actor + reason.
    const audit = batch.find((c) =>
      c.strings.join(" ").includes("INSERT INTO beacon_brain_revert_log"),
    );
    expect(audit).toBeDefined();
    expect(audit?.values).toContain("manager@zoca.com");
    expect(audit?.values).toContain("wrong call");
    expect(audit?.values).toContain(winnerId);
    expect(audit?.values).toContain(loserId);

    // Both version-log INSERTs use change_reason='restored' (the literal lives
    // inside the template string, not the parameters).
    const versionInserts = batch.filter((c) =>
      c.strings.join(" ").includes("INSERT INTO beacon_brain_fact_versions"),
    );
    expect(versionInserts).toHaveLength(2);
    for (const v of versionInserts) {
      expect(v.strings.join(" ")).toContain("'restored'");
    }
  });

  it("trims and clips a 1000-char reason at 500 chars", async () => {
    const { revertSupersession } = await loadModule();
    factsStore.set("W", makeFact({ fact_id: "W", superseded_by: null }));
    factsStore.set("L", makeFact({ fact_id: "L", superseded_by: "W" }));

    const big = "x".repeat(1000);
    const res = await revertSupersession("W", "manager@zoca.com", big);
    expect(res.ok).toBe(true);
    const audit = txBatches[0].find((c) =>
      c.strings.join(" ").includes("INSERT INTO beacon_brain_revert_log"),
    );
    const reasonParam = audit?.values.find(
      (v) => typeof v === "string" && (v as string).startsWith("x"),
    ) as string | undefined;
    expect(reasonParam).toBeDefined();
    expect(reasonParam!.length).toBe(500);
  });

  it("handles a null reason cleanly (no string ops crash)", async () => {
    const { revertSupersession } = await loadModule();
    factsStore.set("W", makeFact({ fact_id: "W", superseded_by: null }));
    factsStore.set("L", makeFact({ fact_id: "L", superseded_by: "W" }));

    const res = await revertSupersession("W", "manager@zoca.com");
    expect(res.ok).toBe(true);
    const audit = txBatches[0].find((c) =>
      c.strings.join(" ").includes("INSERT INTO beacon_brain_revert_log"),
    );
    // Audit row carries null as the reason parameter. .toContain(null) is
    // not supported on arrays, so assert on the parameter position directly:
    // the reason is the last value bound in the INSERT.
    expect(audit?.values[audit.values.length - 1]).toBeNull();
  });
});

describe("revertSupersession — soft-fail cases", () => {
  it("returns no_ancestor when nothing was superseded by this fact", async () => {
    const { revertSupersession } = await loadModule();
    factsStore.set("solo", makeFact({ fact_id: "solo", superseded_by: null }));

    const res = await revertSupersession("solo", "manager@zoca.com");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("no_ancestor");
    expect(res.message).toMatch(/nothing to revert to/i);
    // No transaction runs — the function bails before sql.transaction.
    expect(txBatches).toHaveLength(0);
  });

  it("returns fact_not_found when the target fact_id doesn't exist", async () => {
    const { revertSupersession } = await loadModule();
    const res = await revertSupersession("ghost-uuid", "manager@zoca.com");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("fact_not_found");
    expect(txBatches).toHaveLength(0);
  });

  it("returns fact_not_found when the target fact is soft-deleted", async () => {
    const { revertSupersession } = await loadModule();
    factsStore.set(
      "deleted",
      makeFact({
        fact_id: "deleted",
        soft_deleted_at: new Date().toISOString(),
      }),
    );
    const res = await revertSupersession("deleted", "manager@zoca.com");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("fact_not_found");
  });

  it("returns chain_broken when the ancestor belongs to a different customer", async () => {
    const { revertSupersession } = await loadModule();
    factsStore.set(
      "W",
      makeFact({ fact_id: "W", customer_id: "cust-A", superseded_by: null }),
    );
    // Loser points at W but is on a different customer — corrupt chain.
    factsStore.set(
      "L",
      makeFact({ fact_id: "L", customer_id: "cust-OTHER", superseded_by: "W" }),
    );

    const res = await revertSupersession("W", "manager@zoca.com");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("chain_broken");
    expect(txBatches).toHaveLength(0);
  });
});

describe("revertSupersession — idempotency", () => {
  it("re-reverting a freshly-reverted fact swaps the pair back consistently", async () => {
    // The second revert can't see the first revert's writes (our mock store
    // doesn't simulate writes back into the FactRow map). Instead, the
    // idempotency property we DO want to assert is: the function ALWAYS picks
    // the most-recent ancestor as the revert target, so toggling the
    // store-state simulates the back-and-forth.
    const { revertSupersession } = await loadModule();
    const winnerId = "W";
    const loserId = "L";
    // Phase 1: L is superseded by W. Revert → revert WINNER=W to LOSER=L.
    factsStore.set(winnerId, makeFact({ fact_id: winnerId, superseded_by: null }));
    factsStore.set(loserId, makeFact({ fact_id: loserId, superseded_by: winnerId }));

    const first = await revertSupersession(winnerId, "manager@zoca.com");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.revertedFromFactId).toBe(winnerId);
    expect(first.revertedToFactId).toBe(loserId);

    // Phase 2: persist would have swapped which one is authoritative. We
    // mimic that on the in-memory store and re-run. The function should now
    // identify W as the ancestor (it's superseded by L).
    factsStore.set(winnerId, makeFact({ fact_id: winnerId, superseded_by: loserId }));
    factsStore.set(loserId, makeFact({ fact_id: loserId, superseded_by: null }));

    const second = await revertSupersession(loserId, "manager@zoca.com");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.revertedFromFactId).toBe(loserId);
    expect(second.revertedToFactId).toBe(winnerId);
    // Two batched transactions, both successful — no accumulated state corruption.
    expect(txBatches).toHaveLength(2);
  });
});

describe("revertSupersession — audit-row contents", () => {
  it("stamps actor_email + both fact_ids + customer_id on the revert_log row", async () => {
    const { revertSupersession } = await loadModule();
    factsStore.set("winner", makeFact({ fact_id: "winner", superseded_by: null }));
    factsStore.set("ancestor", makeFact({ fact_id: "ancestor", superseded_by: "winner" }));

    await revertSupersession("winner", "success@zoca.com", "ranking error");
    const audit = txBatches[0].find((c) =>
      c.strings.join(" ").includes("INSERT INTO beacon_brain_revert_log"),
    );
    expect(audit).toBeDefined();
    expect(audit?.values).toEqual([
      "cust-A",       // customer_id
      "winner",       // reverted_from_fact_id
      "ancestor",     // reverted_to_fact_id
      "success@zoca.com",
      "ranking error",
    ]);
  });

  it("emits exactly one revert_log INSERT per call (not two)", async () => {
    const { revertSupersession } = await loadModule();
    factsStore.set("W", makeFact({ fact_id: "W", superseded_by: null }));
    factsStore.set("L", makeFact({ fact_id: "L", superseded_by: "W" }));

    await revertSupersession("W", "manager@zoca.com");
    const auditRows = txBatches[0].filter((c) =>
      c.strings.join(" ").includes("INSERT INTO beacon_brain_revert_log"),
    );
    expect(auditRows).toHaveLength(1);
  });
});

describe("canRevert", () => {
  it("returns true when a non-deleted ancestor exists", async () => {
    const { canRevert } = await loadModule();
    factsStore.set("W", makeFact({ fact_id: "W", superseded_by: null }));
    factsStore.set("L", makeFact({ fact_id: "L", superseded_by: "W" }));
    expect(await canRevert("W")).toBe(true);
  });

  it("returns false when no ancestor exists", async () => {
    const { canRevert } = await loadModule();
    factsStore.set("solo", makeFact({ fact_id: "solo", superseded_by: null }));
    expect(await canRevert("solo")).toBe(false);
  });

  it("ignores soft-deleted ancestors", async () => {
    const { canRevert } = await loadModule();
    factsStore.set("W", makeFact({ fact_id: "W", superseded_by: null }));
    factsStore.set(
      "L",
      makeFact({
        fact_id: "L",
        superseded_by: "W",
        soft_deleted_at: new Date().toISOString(),
      }),
    );
    expect(await canRevert("W")).toBe(false);
  });
});
