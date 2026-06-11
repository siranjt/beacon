-- SMART-K4 followup — flag derived children when parent gets superseded.
--
-- Wave-2's persistResolution marks losing facts as superseded_by = winner_id.
-- SMART-K4 added derived_from so child facts (e.g. owner_email derived from
-- owner_info) point at their parent. But when a parent itself gets superseded,
-- the derived children are still pointing at the (now demoted) parent — and
-- they're almost certainly stale truth too.
--
-- We don't want to silently drop them in retrieval (the K4 agent noted that
-- correctly: that's worse than flagging). Instead, we mark them
-- needs_parent_review = true so the Validate inbox surfaces them and an AM
-- decides: rewrite, supersede, or unlink from the dead parent.
--
-- Cascade is bounded to DIRECT children only — we don't auto-flag
-- grandchildren. AM choice propagates downward only via their explicit edits.
--
-- Backwards compatible: every existing row gets the default (false). No
-- backfill required; the column flips lazily as new supersede events fire
-- through persistResolution.
--
-- Migration-runner note: no PL/pgSQL DO blocks, no $$ tags — runner splits
-- on `;` at EOL and that's all this file uses.

ALTER TABLE beacon_brain_facts
  ADD COLUMN IF NOT EXISTS needs_parent_review BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE beacon_brain_facts
  ADD COLUMN IF NOT EXISTS parent_review_reason TEXT NULL;

-- Partial index on the hot inbox query: "give me an AM's facts that need
-- parent review". Filtered to needs_parent_review = true so the index stays
-- tiny — only the small slice of facts whose parent has been demoted.
CREATE INDEX IF NOT EXISTS beacon_brain_facts_needs_review_idx
  ON beacon_brain_facts (owning_am_email, needs_parent_review)
  WHERE needs_parent_review = true
    AND soft_deleted_at IS NULL;
