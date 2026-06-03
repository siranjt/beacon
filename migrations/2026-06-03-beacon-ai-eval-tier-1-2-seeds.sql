-- Phase F-polish-AI Tier 3 — extend the eval library with cases that
-- specifically guard the Tier 1 + Tier 2 wins.
--
-- The original E-17.3c seeds cover surface-level "the data flows" sanity
-- tests. These new cases pin the failures that triggered the F-polish-AI
-- push — if Beacon AI ever regresses on these, the nightly eval cron
-- will flag it before a manager sees it again.
--
-- Idempotent (ON CONFLICT (id) DO UPDATE). Each pair has a stable UUID
-- in the 100x range so the original 0001-0007 cases stay untouched.

INSERT INTO beacon_ai_eval_pairs (id, scope_kind, scope_params, question, expected_facts, expected_anti_facts, rationale, active)
VALUES
  -- ---------- TIER 1 — silence-by-AM at 30/60/90/120 ----------
  -- This is the question that triggered the entire F-polish-AI push.
  -- Beacon AI used to refuse with "no per-AM breakdown" — Tier 1 added
  -- outbound_silence_buckets_by_am to the customer-book context.
  ('00000000-0000-0000-0000-000000000101'::uuid,
   'customer-book', NULL,
   'For last 30, 60, 90, and 120 days, how many users have we not contacted, grouped by AM? Output AM name + count of accounts per threshold.',
   '["a per-AM table or list", "30-day threshold count for each AM named", "60-day threshold count", "90-day threshold count", "120-day threshold count"]'::jsonb,
   '["I do not have that breakdown", "no per-AM breakdown", "I only have 14d and 30d totals", "ask the data team", "I cannot break this down by AM"]'::jsonb,
   'Tier 1 win — pre-computed outbound_silence_buckets_by_am must always be reachable from this question.',
   TRUE),

  -- ---------- TIER 2 — query_customer_book: MRR by tier ----------
  -- Verifies the new generalized slice-and-dice tool fires when CONTEXT
  -- doesn't carry MRR-by-tier pre-computed.
  ('00000000-0000-0000-0000-000000000102'::uuid,
   'customer-book', NULL,
   'What is total MRR by tier across the active book?',
   '["a tier breakdown", "a dollar amount per tier OR an aggregate per tier", "at least 2 tiers named"]'::jsonb,
   '["I do not have MRR data", "ask the finance team", "MRR is tracked elsewhere"]'::jsonb,
   'Tier 2 win — query_customer_book(metric=mrr, group_by=tier, buckets=sum) should fire and the model should format the result.',
   TRUE),

  -- ---------- TIER 2 — query_customer_book: open tickets by pod ----------
  ('00000000-0000-0000-0000-000000000103'::uuid,
   'customer-book', NULL,
   'Show me open tickets by pod.',
   '["mentions pods or pod names", "ticket counts per pod"]'::jsonb,
   '["I cannot group by pod", "no pod breakdown available"]'::jsonb,
   'Tier 2 win — pod is a valid group_by axis on query_customer_book.',
   TRUE),

  -- ---------- TIER 2 — composite distribution among RED ----------
  ('00000000-0000-0000-0000-000000000104'::uuid,
   'customer-book', NULL,
   'What is the composite score distribution among RED customers — how many are 50-79 vs 80+?',
   '["a count for 50-79 range OR similar bucket", "a count for 80+ range OR similar bucket", "RED filter applied"]'::jsonb,
   '["I do not have composite scores"]'::jsonb,
   'Tier 2 win — query_customer_book with filter={stoplight:[RED]} + range buckets should fire.',
   TRUE),

  -- ---------- TIER 1 GUARD — pre-computed > tool call ----------
  -- The prompt explicitly says "if CONTEXT has the answer, don't call
  -- the tool". This case verifies the model takes the cheap path
  -- instead of always reaching for query_customer_book.
  ('00000000-0000-0000-0000-000000000105'::uuid,
   'customer-book', NULL,
   'Quick health summary of my book — RED/YELLOW/GREEN split?',
   '["a RED count", "a YELLOW count", "a GREEN count", "concise (3-4 sentences max)"]'::jsonb,
   '["I need to run a query", "calling query_customer_book"]'::jsonb,
   'Tier 1 guard — counts are pre-computed; the model should NOT detour through the tool.',
   TRUE),

  -- ---------- GAP REPORTING — out-of-data threshold ----------
  -- 45-day silence isn't a pre-computed threshold and the tool only
  -- supports the standard 30/60/90/120 set today. This case verifies
  -- the model EMITS a `<gap: data_missing — ...>` marker rather than
  -- silently approximating.
  ('00000000-0000-0000-0000-000000000106'::uuid,
   'customer-book', NULL,
   'How many customers are silent for at least 45 days, by AM?',
   '["acknowledges 45 days is not a pre-computed threshold", "offers the closest standard thresholds (30 or 60)"]'::jsonb,
   '["confidently makes up a 45-day number", "claims a 45d count without flagging the approximation"]'::jsonb,
   'Gap reporting — model should call out that 45d is non-standard and offer 30d or 60d.',
   TRUE),

  -- ---------- BULK-ACTION REFUSAL ----------
  -- Existing prompt rule: "I can act on one at a time today — batch
  -- actions are coming." Make sure that stays the case.
  ('00000000-0000-0000-0000-000000000107'::uuid,
   'customer-book', NULL,
   'Snooze all my RED customers for a week.',
   '["refuses the bulk action", "offers to start with one customer", "mentions one-at-a-time"]'::jsonb,
   '["proposes multiple tool calls", "snoozes everyone at once", "Bulk-snoozed"]'::jsonb,
   'Hard one-tool-per-turn cap — should never propose multiple snooze actions in one turn.',
   TRUE),

  -- ---------- SENTIMENT CONSISTENCY (#342 regression guard) ----------
  ('00000000-0000-0000-0000-000000000108'::uuid,
   'customer-book', NULL,
   'Which of my top at-risk customers are tense or escalating?',
   '["names specific customers OR clearly says none", "uses sentiment vocabulary (tense / escalating / warm) consistently"]'::jsonb,
   '["contradicts itself within the same answer", "calls the same customer both warm and tense"]'::jsonb,
   '#342 regression guard — sentiment must be consistent within a single answer.',
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
