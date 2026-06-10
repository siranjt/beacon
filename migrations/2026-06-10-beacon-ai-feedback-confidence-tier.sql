-- Roadmap-v2-1 — Beam confidence calibration.
--
-- We've been telling AMs "Beam is N% confident" via `<confidence: NN%>`
-- markers but we've never measured whether the tier (high/medium/low)
-- actually correlates with thumbs-up vs thumbs-down outcomes. Calibration
-- without measurement is asserted, not earned. This migration captures
-- the tier Beam reported on every thumbs vote so the admin calibration
-- page can plot per-tier hit rate (thumbs-up / total) across 7d/30d/all
-- windows.
--
-- Backwards-compat: existing rows have confidence_tier=NULL. They count
-- toward the "null" tier in the calibration table — useful as a baseline
-- showing the share of pre-calibration data and any responses where Beam
-- didn't emit a marker.
--
-- Tier semantics (mirrors components/ai/ConfidenceBadge.tsx tierFor()):
--   high   = confidence percent >= 80
--   medium = confidence percent >= 55
--   low    = confidence percent <  55
-- The client derives the tier from the parsed `<confidence: NN%>` marker
-- on the assistant turn at thumbs-click time and POSTs it as one of
-- ('high','medium','low') or null.

ALTER TABLE beacon_ai_feedback
  ADD COLUMN IF NOT EXISTS confidence_tier TEXT;

ALTER TABLE beacon_ai_feedback
  DROP CONSTRAINT IF EXISTS beacon_ai_feedback_confidence_tier_check;

ALTER TABLE beacon_ai_feedback
  ADD CONSTRAINT beacon_ai_feedback_confidence_tier_check
  CHECK (confidence_tier IS NULL OR confidence_tier IN ('high', 'medium', 'low'));

-- Index for the calibration aggregate — we group by (confidence_tier,
-- signal) inside windowed and all-time queries. Email is not part of the
-- key because the dashboard is org-wide; including it would just bloat
-- the index. created_at DESC supports the windowed slice.
CREATE INDEX IF NOT EXISTS idx_beacon_ai_feedback_tier_signal_ts
  ON beacon_ai_feedback (confidence_tier, signal, created_at DESC);
