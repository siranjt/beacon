-- Beacon Brain — Wave 1.1 schema extension.
--
-- Adds the value_numeric column to support dual-column queries on
-- numeric-shaped fields (staff_count, location_count). Existing rows
-- get NULL — only new writes to numeric fields populate it.
--
-- No category enum constraint to update (topic_category is TEXT NOT NULL
-- with no CHECK). The new 'relationship' category and 9 new subcategories
-- are added in lib/brain/types.ts FIELD_CATALOG; the DB doesn't restrict
-- topic_category values, so no migration needed for the taxonomy itself.
--
-- Migration-runner note: splits on ';' at line end. No PL/pgSQL DO blocks.

ALTER TABLE beacon_brain_facts
  ADD COLUMN IF NOT EXISTS value_numeric INT;

-- Partial index on the populated subset. Most rows will have
-- value_numeric NULL because most fields aren't numeric-shaped.
-- A partial index keeps the table small and queries on numeric fields
-- fast.
CREATE INDEX IF NOT EXISTS beacon_brain_facts_value_numeric_idx
  ON beacon_brain_facts (field_name, value_numeric)
  WHERE value_numeric IS NOT NULL;
