/**
 * Phase E-17.3c — Beacon AI eval harness.
 *
 * Three responsibilities:
 *   1. Storage CRUD for golden Q&A pairs + run history
 *   2. Judge function: Haiku-as-judge for semantic coverage scoring
 *   3. Runner: iterate active pairs, call the AI, judge, persist
 *
 * Design choices:
 *   - Semantic scoring via Haiku, not regex. LLM output varies in
 *     phrasing; what matters is whether the expected FACTS were covered.
 *   - Pairs are curated by humans (you), not auto-generated. We seed a
 *     handful as examples; the library grows over time.
 *   - Failures are scored on three levels (pass / partial / fail / error)
 *     so subtle regressions show up without being catastrophic.
 *   - The runner calls the underlying answer function directly (not over
 *     HTTP) so we avoid auth + network overhead and can run from cron
 *     without needing the cron secret round-trip.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getSql } from "@/lib/customer/postgres";

const JUDGE_MODEL = process.env.ANTHROPIC_JUDGE_MODEL ?? "claude-haiku-4-5-20251001";
const JUDGE_MAX_TOKENS = 800;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvalScopeKind =
  | "inbox"
  | "customer-360"
  | "customer-book"
  | "performance-landing"
  | "performance-report"
  | "escalation-overview"
  | "post-payment-book"
  | "post-payment-customer";

export interface EvalPair {
  id: string;
  scope_kind: EvalScopeKind;
  scope_params: Record<string, string> | null;
  question: string;
  expected_facts: string[];
  expected_anti_facts: string[] | null;
  rationale: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EvalRun {
  id: string;
  pair_id: string;
  ran_at: string;
  ai_response: string;
  ai_response_ms: number;
  judge_verdict: "pass" | "partial" | "fail" | "error";
  judge_reasoning: string | null;
  facts_covered: string[] | null;
  facts_missed: string[] | null;
  anti_facts_triggered: string[] | null;
  passed: boolean;
}

interface JudgeResult {
  verdict: "pass" | "partial" | "fail";
  reasoning: string;
  facts_covered: string[];
  facts_missed: string[];
  anti_facts_triggered: string[];
}

// ---------------------------------------------------------------------------
// CRUD — pairs
// ---------------------------------------------------------------------------

export async function listActivePairs(scopeKind?: EvalScopeKind): Promise<EvalPair[]> {
  const sql = getSql();
  if (!sql) return [];
  const rows = scopeKind
    ? (await sql`
        SELECT id, scope_kind, scope_params, question, expected_facts,
               expected_anti_facts, rationale, active, created_at, updated_at
        FROM beacon_ai_eval_pairs
        WHERE active = TRUE AND scope_kind = ${scopeKind}
        ORDER BY created_at
      `) as Array<EvalPair>
    : (await sql`
        SELECT id, scope_kind, scope_params, question, expected_facts,
               expected_anti_facts, rationale, active, created_at, updated_at
        FROM beacon_ai_eval_pairs
        WHERE active = TRUE
        ORDER BY scope_kind, created_at
      `) as Array<EvalPair>;
  return rows;
}

export async function upsertPair(input: {
  id?: string;
  scope_kind: EvalScopeKind;
  scope_params?: Record<string, string> | null;
  question: string;
  expected_facts: string[];
  expected_anti_facts?: string[] | null;
  rationale?: string | null;
  active?: boolean;
}): Promise<string> {
  const sql = getSql();
  if (!sql) throw new Error("POSTGRES_URL not set");
  const active = input.active ?? true;
  if (input.id) {
    await sql`
      UPDATE beacon_ai_eval_pairs SET
        scope_kind = ${input.scope_kind},
        scope_params = ${JSON.stringify(input.scope_params ?? null)}::jsonb,
        question = ${input.question},
        expected_facts = ${JSON.stringify(input.expected_facts)}::jsonb,
        expected_anti_facts = ${JSON.stringify(input.expected_anti_facts ?? null)}::jsonb,
        rationale = ${input.rationale ?? null},
        active = ${active},
        updated_at = NOW()
      WHERE id = ${input.id}::uuid
    `;
    return input.id;
  }
  const rows = (await sql`
    INSERT INTO beacon_ai_eval_pairs (
      scope_kind, scope_params, question, expected_facts,
      expected_anti_facts, rationale, active
    ) VALUES (
      ${input.scope_kind},
      ${JSON.stringify(input.scope_params ?? null)}::jsonb,
      ${input.question},
      ${JSON.stringify(input.expected_facts)}::jsonb,
      ${JSON.stringify(input.expected_anti_facts ?? null)}::jsonb,
      ${input.rationale ?? null},
      ${active}
    )
    RETURNING id
  `) as Array<{ id: string }>;
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// CRUD — runs
// ---------------------------------------------------------------------------

export async function recordRun(input: {
  pair_id: string;
  ai_response: string;
  ai_response_ms: number;
  judge_verdict: EvalRun["judge_verdict"];
  judge_reasoning: string | null;
  facts_covered: string[] | null;
  facts_missed: string[] | null;
  anti_facts_triggered: string[] | null;
  passed: boolean;
}): Promise<void> {
  const sql = getSql();
  if (!sql) return;
  const truncatedResponse = input.ai_response.slice(0, 4000);
  await sql`
    INSERT INTO beacon_ai_eval_runs (
      pair_id, ai_response, ai_response_ms,
      judge_verdict, judge_reasoning,
      facts_covered, facts_missed, anti_facts_triggered, passed
    ) VALUES (
      ${input.pair_id}::uuid,
      ${truncatedResponse},
      ${input.ai_response_ms},
      ${input.judge_verdict},
      ${input.judge_reasoning},
      ${JSON.stringify(input.facts_covered ?? [])}::jsonb,
      ${JSON.stringify(input.facts_missed ?? [])}::jsonb,
      ${JSON.stringify(input.anti_facts_triggered ?? [])}::jsonb,
      ${input.passed}
    )
  `;
}

/** Aggregate pass rate over the last N runs per pair. Used by the
 *  regression detector to compare today vs. baseline. */
export async function getRollingPassRate(
  windowDays: number,
): Promise<{ total: number; passed: number; passRate: number }> {
  const sql = getSql();
  if (!sql) return { total: 0, passed: 0, passRate: 0 };
  const rows = (await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE passed = TRUE)::int AS passed
    FROM beacon_ai_eval_runs
    WHERE ran_at >= NOW() - (${windowDays}::int || ' days')::interval
  `) as Array<{ total: number; passed: number }>;
  const total = Number(rows[0]?.total ?? 0);
  const passed = Number(rows[0]?.passed ?? 0);
  return { total, passed, passRate: total > 0 ? passed / total : 0 };
}

// ---------------------------------------------------------------------------
// Judge — Haiku-as-judge
// ---------------------------------------------------------------------------

/**
 * Score whether the AI's answer covers the expected facts.
 *
 * We give Haiku the question, the AI's answer, the expected facts, and
 * the anti-facts. It returns structured JSON enumerating which facts
 * were/weren't covered. We map to pass/partial/fail:
 *   - All expected facts covered AND no anti-facts triggered → pass
 *   - Some facts covered, no anti-facts → partial
 *   - Most facts missed OR any anti-fact triggered → fail
 *
 * The judge is intentionally lenient on phrasing — only semantic coverage
 * matters. "HIGH risk tier" matches "this customer is high-risk."
 */
export async function judgeResponse(input: {
  question: string;
  ai_response: string;
  expected_facts: string[];
  expected_anti_facts: string[];
}): Promise<JudgeResult> {
  const promptSystem = `You are an evaluator scoring whether a customer-success AI's answer covers a list of expected facts.

You will be given:
  - The QUESTION the user asked
  - The AI'S ANSWER
  - A list of EXPECTED FACTS the answer should cover (semantic match, not exact wording)
  - A list of ANTI-FACTS the answer must NOT contain (confabulations, wrong info)

Return STRICT JSON with these fields:
{
  "facts_covered": ["..."],       // exact strings from expected_facts that ARE covered semantically
  "facts_missed": ["..."],         // exact strings from expected_facts that are NOT covered
  "anti_facts_triggered": ["..."], // exact strings from anti-facts that DO appear (bad)
  "reasoning": "1-2 sentences explaining the verdict"
}

Be lenient on phrasing. Be strict on substance — if the fact is about a specific number, the answer must reference that number or a close variant. If the fact is about a relationship, the answer must mention it.`;

  const userMsg = `QUESTION:
${input.question}

AI'S ANSWER:
${input.ai_response}

EXPECTED FACTS (must be covered):
${JSON.stringify(input.expected_facts, null, 2)}

ANTI-FACTS (must NOT appear):
${JSON.stringify(input.expected_anti_facts, null, 2)}

Return JSON only.`;

  const res = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: JUDGE_MAX_TOKENS,
    system: promptSystem,
    messages: [{ role: "user", content: userMsg }],
  });

  // Extract text from response blocks
  let text = "";
  for (const block of res.content) {
    if (block.type === "text") text += block.text;
  }

  // Parse JSON (Haiku usually returns clean JSON, but strip code-fences if present)
  let json: Partial<JudgeResult>;
  try {
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    json = JSON.parse(cleaned);
  } catch {
    // Fallback: treat as failure with raw text as reasoning
    return {
      verdict: "fail",
      reasoning: `Judge returned non-JSON: ${text.slice(0, 200)}`,
      facts_covered: [],
      facts_missed: input.expected_facts,
      anti_facts_triggered: [],
    };
  }

  const facts_covered = Array.isArray(json.facts_covered) ? json.facts_covered : [];
  const facts_missed = Array.isArray(json.facts_missed)
    ? json.facts_missed
    : input.expected_facts.filter((f) => !facts_covered.includes(f));
  const anti_facts_triggered = Array.isArray(json.anti_facts_triggered)
    ? json.anti_facts_triggered
    : [];
  const reasoning = typeof json.reasoning === "string" ? json.reasoning : "";

  // Verdict logic
  const totalExpected = input.expected_facts.length;
  const coverageRatio = totalExpected > 0 ? facts_covered.length / totalExpected : 1;
  const hasAntiFact = anti_facts_triggered.length > 0;
  let verdict: JudgeResult["verdict"];
  if (hasAntiFact) verdict = "fail";
  else if (coverageRatio >= 0.85) verdict = "pass";
  else if (coverageRatio >= 0.5) verdict = "partial";
  else verdict = "fail";

  return { verdict, reasoning, facts_covered, facts_missed, anti_facts_triggered };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a single pair through the AI + judge + persistence pipeline.
 *
 * Calls the AI ask endpoint via HTTP (so it goes through the same code
 * path users hit) but uses a service-level fake session header so the
 * route's auth gate doesn't reject. The eval runner has to be allowed
 * to bypass session auth — see /api/ai/ask for the EVAL_RUNNER_TOKEN
 * check.
 */
export async function runPair(
  pair: EvalPair,
  apiBaseUrl: string,
  evalToken: string,
): Promise<{ verdict: EvalRun["judge_verdict"]; reasoning: string }> {
  // Reconstruct an AiScope object the ask endpoint understands.
  const scope = pairToScope(pair.scope_kind, pair.scope_params);

  const t0 = Date.now();
  let aiResponse = "";
  let aiResponseMs = 0;
  try {
    // Vercel Deployment Protection is in front of /api/ai/ask in production.
    // Server-to-server cron calls bypass it via the project's "Protection
    // Bypass for Automation" token. Pass-through header is documented at
    // https://vercel.com/docs/security/deployment-protection/methods-to-bypass-deployment-protection
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-eval-runner-token": evalToken,
    };
    const protectionBypass = process.env.VERCEL_PROTECTION_BYPASS_TOKEN;
    if (protectionBypass) {
      headers["x-vercel-protection-bypass"] = protectionBypass;
      headers["x-vercel-set-bypass-cookie"] = "false";
    }
    const res = await fetch(`${apiBaseUrl}/api/ai/ask`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        scope,
        question: pair.question,
        // Empty history — each eval pair starts fresh
        history: [],
      }),
    });
    aiResponseMs = Date.now() - t0;
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      const reasoning = `AI endpoint returned HTTP ${res.status}: ${errBody.slice(0, 200)}`;
      await recordRun({
        pair_id: pair.id,
        ai_response: errBody.slice(0, 500),
        ai_response_ms: aiResponseMs,
        judge_verdict: "error",
        judge_reasoning: reasoning,
        facts_covered: [],
        facts_missed: pair.expected_facts,
        anti_facts_triggered: null,
        passed: false,
      });
      return { verdict: "error", reasoning };
    }
    // The /api/ai/ask endpoint streams text. Read full body.
    aiResponse = await res.text();
  } catch (e) {
    aiResponseMs = Date.now() - t0;
    const message = e instanceof Error ? e.message : String(e);
    const reasoning = `AI endpoint threw: ${message}`;
    await recordRun({
      pair_id: pair.id,
      ai_response: message.slice(0, 500),
      ai_response_ms: aiResponseMs,
      judge_verdict: "error",
      judge_reasoning: reasoning,
      facts_covered: [],
      facts_missed: pair.expected_facts,
      anti_facts_triggered: null,
      passed: false,
    });
    return { verdict: "error", reasoning };
  }

  // Judge the response
  let judged: JudgeResult;
  try {
    judged = await judgeResponse({
      question: pair.question,
      ai_response: aiResponse,
      expected_facts: pair.expected_facts,
      expected_anti_facts: pair.expected_anti_facts ?? [],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await recordRun({
      pair_id: pair.id,
      ai_response: aiResponse,
      ai_response_ms: aiResponseMs,
      judge_verdict: "error",
      judge_reasoning: `Judge threw: ${message}`,
      facts_covered: [],
      facts_missed: pair.expected_facts,
      anti_facts_triggered: null,
      passed: false,
    });
    return { verdict: "error", reasoning: `Judge threw: ${message}` };
  }

  const passed = judged.verdict === "pass";
  await recordRun({
    pair_id: pair.id,
    ai_response: aiResponse,
    ai_response_ms: aiResponseMs,
    judge_verdict: judged.verdict,
    judge_reasoning: judged.reasoning,
    facts_covered: judged.facts_covered,
    facts_missed: judged.facts_missed,
    anti_facts_triggered: judged.anti_facts_triggered,
    passed,
  });

  return { verdict: judged.verdict, reasoning: judged.reasoning };
}

/** Map a scope_kind + params row back to an AiScope object the ask
 *  endpoint accepts. Mirrors the discriminated union shape in lib/ai/scopes.ts. */
function pairToScope(
  kind: EvalScopeKind,
  params: Record<string, string> | null,
): Record<string, string> {
  switch (kind) {
    case "inbox":
      return { kind: "inbox" };
    case "customer-book":
      return { kind: "customer-book" };
    case "customer-360":
      return { kind: "customer-360", entityId: params?.entity_id ?? "" };
    case "performance-landing":
      return { kind: "performance-landing" };
    case "performance-report":
      return { kind: "performance-report", entityId: params?.entity_id ?? "" };
    case "escalation-overview":
      return { kind: "escalation-overview" };
    case "post-payment-book":
      return { kind: "post-payment-book" };
    case "post-payment-customer":
      return {
        kind: "post-payment-customer",
        cbCustomerId: params?.cb_customer_id ?? "",
      };
  }
}

/**
 * Run ALL active pairs. Returns aggregated stats.
 */
export async function runAllActive(
  apiBaseUrl: string,
  evalToken: string,
): Promise<{
  total: number;
  passed: number;
  partial: number;
  failed: number;
  errored: number;
  results: Array<{ pair_id: string; question: string; verdict: string; reasoning: string }>;
}> {
  const pairs = await listActivePairs();
  const stats = { total: 0, passed: 0, partial: 0, failed: 0, errored: 0 };
  const results: Array<{
    pair_id: string;
    question: string;
    verdict: string;
    reasoning: string;
  }> = [];

  // Sequential — keeps load on the AI endpoint + judge model light
  for (const pair of pairs) {
    stats.total++;
    try {
      const r = await runPair(pair, apiBaseUrl, evalToken);
      if (r.verdict === "pass") stats.passed++;
      else if (r.verdict === "partial") stats.partial++;
      else if (r.verdict === "fail") stats.failed++;
      else stats.errored++;
      results.push({
        pair_id: pair.id,
        question: pair.question,
        verdict: r.verdict,
        reasoning: r.reasoning,
      });
    } catch (e) {
      stats.errored++;
      results.push({
        pair_id: pair.id,
        question: pair.question,
        verdict: "error",
        reasoning: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { ...stats, results };
}
