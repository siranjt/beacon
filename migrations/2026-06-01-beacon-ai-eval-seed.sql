-- Phase E-17.3c — Seed the eval library with canonical Q&A pairs.
--
-- Idempotent: each pair has a stable ID so re-running this migration
-- updates expected_facts in place rather than inserting duplicates.
-- The user can curate / expand / disable pairs via Postgres directly or
-- via a future admin UI. ON CONFLICT (id) makes the seed safe to re-run.

INSERT INTO beacon_ai_eval_pairs (id, scope_kind, scope_params, question, expected_facts, expected_anti_facts, rationale, active)
VALUES
  -- ---------- INBOX ----------
  ('00000000-0000-0000-0000-000000000001'::uuid,
   'inbox', NULL,
   'What needs my attention today?',
   '["mentions at least one customer or topic", "uses recency cues (today/now/this week)", "concrete enough to act on"]'::jsonb,
   '["I cannot see your inbox", "I do not have access to that information"]'::jsonb,
   'Inbox scope must surface actionable items; refusing is a regression',
   TRUE),

  ('00000000-0000-0000-0000-000000000002'::uuid,
   'inbox', NULL,
   'How many customers are at HIGH risk right now?',
   '["a specific number for HIGH tier", "mentions the date or recency of the count"]'::jsonb,
   '["unable to determine", "you should check the dashboard"]'::jsonb,
   'Manager-level question; Beacon AI must give the number, not deflect',
   TRUE),

  -- ---------- CUSTOMER BOOK ----------
  ('00000000-0000-0000-0000-000000000003'::uuid,
   'customer-book', NULL,
   'Which customers had escalating sentiment in the last week?',
   '["mentions sentiment or tone", "lists at least one specific customer if any exist, or says none clearly"]'::jsonb,
   '["sentiment analysis is not available", "I cannot access comms perspectives"]'::jsonb,
   'Tests the perspective sentiment data is reaching the AI',
   TRUE),

  ('00000000-0000-0000-0000-000000000004'::uuid,
   'customer-book', NULL,
   'Summarize my book in one paragraph.',
   '["total customer count", "tier breakdown OR risk distribution", "at most 3-4 sentences (concise)"]'::jsonb,
   NULL,
   'Manager overview question — verifies aggregate data plumbing',
   TRUE),

  -- ---------- ESCALATION ----------
  ('00000000-0000-0000-0000-000000000005'::uuid,
   'escalation-overview', NULL,
   'What escalations are open right now?',
   '["a count or specific escalations", "mentions urgency OR age of escalations"]'::jsonb,
   '["I dont have escalation data", "check the escalation system separately"]'::jsonb,
   'Escalation scope must answer this question — it is the only question on this page',
   TRUE),

  -- ---------- POST-PAYMENT ----------
  ('00000000-0000-0000-0000-000000000006'::uuid,
   'post-payment-book', NULL,
   'Any disputes that need attention?',
   '["mentions disputes specifically", "either lists customers, gives a count, or clearly says none active"]'::jsonb,
   '["disputes are tracked elsewhere"]'::jsonb,
   'Core post-payment question; deflecting to Stripe is a regression',
   TRUE),

  -- ---------- PERFORMANCE LANDING ----------
  ('00000000-0000-0000-0000-000000000007'::uuid,
   'performance-landing', NULL,
   'Whose GBP performance is dropping?',
   '["mentions GBP profile clicks OR lead trend", "either lists customers or summarizes the cohort"]'::jsonb,
   '["I dont have GBP performance data"]'::jsonb,
   'Performance signal must flow through; deflection is regression',
   TRUE)

ON CONFLICT (id) DO UPDATE SET
  scope_kind = EXCLUDED.scope_kind,
  scope_params = EXCLUDED.scope_params,
  question = EXCLUDED.question,
  expected_facts = EXCLUDED.expected_facts,
  expected_anti_facts = EXCLUDED.expected_anti_facts,
  rationale = EXCLUDED.rationale,
  active = EXCLUDED.active,
  updated_at = NOW();
