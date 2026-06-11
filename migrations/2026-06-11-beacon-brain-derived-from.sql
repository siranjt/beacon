-- SMART-K4 (Beam/Keeper fact relationships) — add derived_from column.
--
-- Today every Keeper fact is independent. But facts have real parent /
-- child relationships:
--   - owner_email is derived FROM owner_info
--   - preferred_channel may be derived FROM comms_preference
--   - migration_history may be derived FROM integration/platform
--
-- Without an explicit link, Beam can cite the derived child and miss the
-- parent context. The retrieve auto-pull (see lib/brain/retrieve.ts) uses
-- this column to fetch the parent whenever a derived child lands in the
-- top-K, so the model sees both rows side by side.
--
-- Cross-customer references are an application-layer error — writeBrainFact
-- validates derived_from points at a same-customer fact before persisting.
-- The FK is intentionally NOT scoped on customer_id at the SQL level (it
-- only references fact_id, which is globally unique). ON DELETE SET NULL
-- so deleting a parent doesn't cascade-orphan the children.
--
-- Backwards compatible: every existing row has derived_from=NULL. No
-- backfill required. derived_from stays NULL on every row until an AM
-- (or the add_fact_to_brain tool) sets it.
--
-- Migration-runner note: no PL/pgSQL DO blocks, no $$ tags — runner splits
-- on `;` at EOL and that's all this file uses.

ALTER TABLE beacon_brain_facts
  ADD COLUMN IF NOT EXISTS derived_from UUID NULL
    REFERENCES beacon_brain_facts(fact_id) ON DELETE SET NULL;

-- Lookup index for the auto-pull: "given a fact_id, fetch the parent".
-- Partial — only the small slice of facts that actually have a parent.
CREATE INDEX IF NOT EXISTS beacon_brain_facts_derived_from_idx
  ON beacon_brain_facts (derived_from)
  WHERE derived_from IS NOT NULL;
