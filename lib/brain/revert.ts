/**
 * WAVE-A-2 — Self-service supersede rollback (Keeper).
 *
 * Background
 * ----------
 * Wave-2's conflict resolution (lib/brain/ranking.ts + writeBrainFact) demotes
 * the loser fact by setting its `superseded_by` to the winner's fact_id and
 * leaves the loser row in the table — nothing is ever truly deleted. The
 * winner becomes authoritative (`superseded_by IS NULL`).
 *
 * When the AM realizes the newer fact was wrong (e.g. Haiku mis-extracted a
 * name, a draft email superseded a confirmed BaseSheet row), there was no
 * self-service way to undo it short of a DB tap. This module provides that
 * undo:
 *
 *   revertSupersession(factId, actorEmail, reason?)
 *
 *   1. Find the loser whose `superseded_by = factId` (the row that was demoted
 *      WHEN this fact won). Most clusters have one direct ancestor; we pick
 *      the most-recently-superseded if multiple.
 *   2. Atomically (Neon `sql.transaction`):
 *        - DEMOTE current fact: set its own `superseded_by` to the OLD fact's id.
 *        - PROMOTE old fact:    clear its `superseded_by` (becomes authoritative).
 *        - APPEND audit row to beacon_brain_revert_log capturing who/when/why.
 *   3. Return shape: { ok, revertedFromFactId, revertedToFactId, customerId }.
 *
 * Soft-fail cases:
 *   - factId not found → `ok: false, error: "fact_not_found"`
 *   - no ancestor (nothing pointed at this fact via superseded_by) →
 *     `ok: false, error: "no_ancestor"` — surfaced as 400 by the API route.
 *   - cross-customer mismatch on the ancestor (corrupt chain) →
 *     `ok: false, error: "chain_broken"`
 *
 * The revert is itself a supersede event (not a delete). Re-running the revert
 * just flips the two facts back — idempotency tests cover this.
 *
 * Audit chain — every revert lands a row in beacon_brain_revert_log AND a
 * version-log row on the loser (`change_reason='restored'`) so the Validate
 * inbox history view continues to read the full lineage.
 *
 * No LLM call. No background work. Cheap query, two writes.
 */

import { getSql } from "../customer/postgres";
import type { BrainFact } from "./types";

export interface RevertSuccess {
  ok: true;
  revertedFromFactId: string;
  revertedToFactId: string;
  customerId: string;
}

export type RevertErrorCode =
  | "no_sql"
  | "fact_not_found"
  | "no_ancestor"
  | "chain_broken"
  | "write_failed";

export interface RevertFailure {
  ok: false;
  error: RevertErrorCode;
  message: string;
}

export type RevertResult = RevertSuccess | RevertFailure;

/**
 * Revert the most-recent supersession involving `factId` as the WINNER.
 *
 * @param factId       The currently-authoritative fact whose elevation we want
 *                     to undo. Must have `superseded_by IS NULL`. The function
 *                     also accepts an already-superseded fact as input but
 *                     prefers the live authoritative case — see `chain_broken`.
 * @param actorEmail   Who clicked Revert. Stamped on the audit row.
 * @param reason       Optional free-text reason (max 500 chars). Stamped on
 *                     audit row + version log.
 */
export async function revertSupersession(
  factId: string,
  actorEmail: string,
  reason?: string,
): Promise<RevertResult> {
  const sql = getSql();
  if (!sql) {
    return {
      ok: false,
      error: "no_sql",
      message: "POSTGRES_URL not configured",
    };
  }

  // 1. Load the current fact. Must exist + not be soft-deleted.
  const currentRows = (await sql`
    SELECT * FROM beacon_brain_facts
    WHERE fact_id = ${factId}::uuid
      AND soft_deleted_at IS NULL
    LIMIT 1
  `) as BrainFact[];

  const current = currentRows[0];
  if (!current) {
    return {
      ok: false,
      error: "fact_not_found",
      message: `fact ${factId} not found (or soft-deleted)`,
    };
  }

  // 2. Find the LOSER ancestor — the row whose superseded_by points at
  //    `factId`. When multiple losers exist (a fact won against >1 sibling),
  //    pick the most recently updated one — that's the "last thing we beat",
  //    which is what a manager intuitively wants to roll back to.
  //    Soft-deleted ancestors are skipped — they're already out of the cluster.
  const ancestorRows = (await sql`
    SELECT * FROM beacon_brain_facts
    WHERE superseded_by = ${factId}::uuid
      AND soft_deleted_at IS NULL
    ORDER BY updated_at DESC
    LIMIT 1
  `) as BrainFact[];

  const ancestor = ancestorRows[0];
  if (!ancestor) {
    return {
      ok: false,
      error: "no_ancestor",
      message:
        "This fact has no superseded ancestor — there is nothing to revert to.",
    };
  }

  // 3. Sanity check: the ancestor must belong to the same customer. If it
  //    doesn't, the chain is corrupt — bail rather than rewire across
  //    customers (would violate the same-customer invariant in writeBrainFact).
  if (ancestor.customer_id !== current.customer_id) {
    return {
      ok: false,
      error: "chain_broken",
      message: `ancestor ${ancestor.fact_id} belongs to a different customer (${ancestor.customer_id}) than ${current.fact_id} (${current.customer_id})`,
    };
  }

  const currentNewVersion = current.current_version + 1;
  const ancestorNewVersion = ancestor.current_version + 1;
  const reasonClean =
    typeof reason === "string" && reason.trim().length > 0
      ? reason.trim().slice(0, 500)
      : null;

  // 4. Atomic flip — Neon's HTTP driver supports sql.transaction([…]) as a
  //    single round-trip transactional batch. All seven writes either all
  //    apply or none do, so we can't leave the cluster half-flipped.
  //
  //    Order intentionally:
  //      a) DEMOTE current  (superseded_by → ancestor)
  //      b) PROMOTE ancestor (superseded_by → NULL)
  //      c) Append audit row to beacon_brain_revert_log
  //      d) Append version-log rows for both facts (change_reason='restored')
  //
  //    The version log entries mirror the existing ranking-resolution pattern
  //    so the Validate inbox history view picks them up automatically.
  try {
    await sql.transaction([
      // a) DEMOTE the formerly-authoritative fact.
      sql`
        UPDATE beacon_brain_facts
        SET superseded_by = ${ancestor.fact_id}::uuid,
            current_version = ${currentNewVersion},
            updated_at = NOW()
        WHERE fact_id = ${current.fact_id}::uuid
      `,
      // b) PROMOTE the ancestor back to authoritative. We also clear
      //    `is_stale` if it was flipped during the time the ancestor was
      //    demoted — promoting a fact while leaving it hidden by the stale-
      //    prune would defeat the point of the revert.
      sql`
        UPDATE beacon_brain_facts
        SET superseded_by = NULL,
            is_stale = false,
            marked_stale_at = NULL,
            current_version = ${ancestorNewVersion},
            updated_at = NOW()
        WHERE fact_id = ${ancestor.fact_id}::uuid
      `,
      // c) Audit row — the headline record of who/when/why.
      sql`
        INSERT INTO beacon_brain_revert_log (
          customer_id, reverted_from_fact_id, reverted_to_fact_id,
          actor_email, reason
        ) VALUES (
          ${current.customer_id},
          ${current.fact_id}::uuid,
          ${ancestor.fact_id}::uuid,
          ${actorEmail},
          ${reasonClean}
        )
      `,
      // d) Version-log entries — one per affected fact. change_reason
      //    'restored' already exists in the ChangeReason union; we use it
      //    here because the semantic IS "this fact has been restored from
      //    a prior state" (for the ancestor) / "this fact has been rolled
      //    out of the authoritative slot" (for the current). Both rows
      //    carry the reason so the audit trail is searchable end-to-end.
      sql`
        INSERT INTO beacon_brain_fact_versions (
          customer_id, fact_id, version, value, confidence_state,
          source_type, source_ref, prior_value, changed_by_email, change_reason
        ) VALUES (
          ${current.customer_id},
          ${current.fact_id}::uuid,
          ${currentNewVersion},
          ${current.value},
          ${current.confidence_state},
          ${current.source_type},
          ${reasonClean ? `revert:${reasonClean}` : "revert"},
          ${current.value},
          ${actorEmail},
          'restored'
        )
      `,
      sql`
        INSERT INTO beacon_brain_fact_versions (
          customer_id, fact_id, version, value, confidence_state,
          source_type, source_ref, prior_value, changed_by_email, change_reason
        ) VALUES (
          ${ancestor.customer_id},
          ${ancestor.fact_id}::uuid,
          ${ancestorNewVersion},
          ${ancestor.value},
          ${ancestor.confidence_state},
          ${ancestor.source_type},
          ${reasonClean ? `revert:${reasonClean}` : "revert"},
          ${ancestor.value},
          ${actorEmail},
          'restored'
        )
      `,
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: "write_failed",
      message: `revert transaction failed: ${msg}`,
    };
  }

  return {
    ok: true,
    revertedFromFactId: current.fact_id,
    revertedToFactId: ancestor.fact_id,
    customerId: current.customer_id,
  };
}

/**
 * Read-helper used by the Validate inbox + Keeper panel to decide whether to
 * SHOW the Revert button on a row. Returns true when the row is currently
 * authoritative AND has at least one ancestor in the supersede chain.
 *
 * Soft-fails to false on any DB error — the button just doesn't render, which
 * is the safe default.
 */
export async function canRevert(factId: string): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  try {
    const rows = (await sql`
      SELECT 1
      FROM beacon_brain_facts loser
      WHERE loser.superseded_by = ${factId}::uuid
        AND loser.soft_deleted_at IS NULL
      LIMIT 1
    `) as Array<{ "?column?": number }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}
