-- Phase F — Miss Payment Beacon annotations table.
--
-- One row per Chargebee invoice. Stores manual edits a Finance rep makes
-- in the unpaid-invoice dashboard (caller assignment, connection status,
-- AM comment, comments, old comments). Read on every dashboard load,
-- written on every blur of an editable cell.
--
-- Why a fresh table instead of generic `annotations`:
--   - Keeps the umbrella's table namespace tidy. The standalone Missed
--     Invoice Tracker called this `annotations`; renaming to
--     `miss_payment_annotations` here makes it obvious which agent owns
--     the row when you're staring at psql.
--   - Avoids any future collision if another agent ever wants its own
--     row-level annotations cache.
--
-- Design notes:
--   - invoice_number is the natural PK — it's the Chargebee invoice id
--     (e.g. "INV12345"), unique across the customer base. No need to key
--     by customer + invoice.
--   - `data` is JSONB so the shape can evolve (new fields like
--     "callback_at", "ticket_followup_url") without a migration each
--     time. The lib/miss-payment/annotations.ts helper merges new
--     patches onto whatever's already in the row.
--   - updated_at is set on every upsert via DEFAULT now() so we can
--     surface "last edited 3m ago" in the UI without an extra timestamps
--     table.

CREATE TABLE IF NOT EXISTS miss_payment_annotations (
  invoice_number TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One index on updated_at so the future "recent edits" widget can read
-- the freshest N rows without a sequential scan.
CREATE INDEX IF NOT EXISTS miss_payment_annotations_updated_at_idx
  ON miss_payment_annotations (updated_at DESC);
