/**
 * Negative Keyword Beacon — Haiku classifier. Phase NK-2.4.
 *
 * Stage 2 of the two-stage detector. Pre-screened candidates from
 * `prescreen.ts` come in batches of 20; each batch becomes ONE Haiku
 * call returning JSON for all 20 messages at once. The model:
 *   - re-confirms the message expresses genuine churn-risk sentiment
 *     from the customer's perspective (drops keyword-only false
 *     positives like outbound copy that quotes a complaint)
 *   - assigns a `RiskCategory` (Cancellation / Billing / Lead quality /
 *     Technical / Disappointed / Flagged)
 *   - writes a 2-sentence operator-facing analysis (what the customer
 *     wants + the AM action implied)
 *
 * The batch size of 20 (raised from 12 in OPT-4, ~$8-15/mo savings) fits
 * comfortably under Haiku's context — 20 short snippets capped at 600
 * chars each + ~120 tokens of header is ~5-6K input tokens per call,
 * well below the 2000-token output cap. Haiku handles 20 messages in
 * one structured JSON response without quality loss.
 *
 * If `ANTHROPIC_API_KEY` is missing or the call errors / returns malformed
 * JSON, the caller (cron) is expected to fall through to
 * `analyze-fallback.ts`. This file does NOT silently substitute a regex
 * result — that would mix sources of truth.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CandidateMessage, RiskCategory } from "./types";
import { RISK_CATEGORIES } from "./types";

const MODEL = process.env.ANTHROPIC_NK_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS_PER_BATCH = 2000;
const BATCH_SIZE = 20;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

/** Per-candidate output of the AI stage. */
export interface ClassifyResult {
  /** Index of the corresponding CandidateMessage in the input batch. */
  index: number;
  /** True only if Haiku confirmed real negative-signal AND assigned a category. */
  is_negative: boolean;
  /** Assigned risk category. "Flagged" used as catch-all. */
  category: RiskCategory;
  /** Two-sentence operator-facing analysis. */
  analysis: string;
}

/**
 * Canonical Haiku system prompt. The shape is enforced by
 * `validateBatchResponse` — drift → batch is retried once, then dropped
 * to fallback.
 */
export const CLASSIFY_SYSTEM_PROMPT = `You are screening short customer-to-business messages for genuine negative sentiment or churn risk. Output STRICT JSON only — no prose, no markdown fences.

Input: a numbered list of messages from one or more customers. Each message has an index, a channel (App Chat / Email / SMS), a sender direction (inbound = from customer, outbound = from us), and the body text.

Your task: for EACH index, return one object with:

{
  "index": <integer>,
  "is_negative": <true|false>,
  "category": "Cancellation" | "Billing" | "Lead quality" | "Technical" | "Disappointed" | "Flagged",
  "analysis": "<two sentences — what the customer wants, what the AM should do>"
}

Return an array of these objects, one per input index, in the same order.

Rules:
- is_negative = true ONLY when the message expresses genuine churn risk or material customer dissatisfaction. False positives to drop:
    · keyword-matched outbound copy that QUOTES a customer (e.g. our reply that includes their complaint)
    · routine billing reminders, SMS opt-out automations
    · resolved threads ("thanks for fixing it!")
    · neutral status updates
- If is_negative = false, category MUST be "Flagged" and analysis MUST be one short sentence stating why this was dropped (e.g. "Outbound copy quoting a customer — not a real signal.").
- category mapping:
    · Cancellation — explicit intent to cancel / leave / churn
    · Billing — refund, dispute, chargeback, unexpected charge
    · Lead quality — no leads, spam leads, no ROI
    · Technical — app/site broken, errors, can't log in
    · Disappointed — general dissatisfaction without a specific bucket
    · Flagged — any other negative signal that doesn't fit cleanly
- analysis is 2 sentences MAX. Sentence 1 = what the customer is communicating (concrete, not "the customer is upset"). Sentence 2 = the AM action (specific, e.g. "Call within 24h before they initiate a chargeback.").
- Never invent dollar amounts or facts not in the message.
- Output array length MUST equal input array length. Indices MUST match input order.`;

function isRiskCategory(s: unknown): s is RiskCategory {
  return typeof s === "string" && (RISK_CATEGORIES as readonly string[]).includes(s);
}

function buildBatchUserPrompt(batch: CandidateMessage[]): string {
  const lines: string[] = [];
  batch.forEach((c, i) => {
    const body = (c.message_body || "").replace(/\s+/g, " ").trim().slice(0, 600);
    const dir = c.direction === "inbound" ? "from-customer" : c.direction;
    lines.push(`[${i}] channel=${c.source} dir=${dir} sender="${c.sender_name}": ${body}`);
  });
  return `Classify each message below. Return a JSON array of ${batch.length} objects (one per index, in order).\n\n${lines.join("\n\n")}`;
}

function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validateBatchResponse(
  parsed: unknown[],
  batchSize: number,
): ClassifyResult[] | null {
  if (parsed.length !== batchSize) return null;
  const out: ClassifyResult[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const raw = parsed[i];
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const index = typeof r.index === "number" ? r.index : i;
    if (index !== i) return null; // model didn't preserve order
    const is_negative = r.is_negative === true;
    const category = isRiskCategory(r.category) ? r.category : "Flagged";
    const analysis =
      typeof r.analysis === "string" && r.analysis.trim()
        ? r.analysis.trim().slice(0, 500)
        : "No analysis available.";
    out.push({ index, is_negative, category, analysis });
  }
  return out;
}

/**
 * Classify one batch. Returns null on missing key, network error, or
 * malformed JSON. Caller falls through to the regex fallback.
 *
 * OPT-6: removed the inline `for (attempt < 2)` retry loop. The
 * Anthropic SDK is configured with `maxRetries: 2` above — it already
 * retries on transient 429/5xx errors. The inline loop stacked on top of
 * that (a single bad-JSON response could fire up to 6 API calls). JSON
 * parse failures are deterministic — retrying a malformed response gives
 * the same malformed response. Drop straight to fallback instead.
 */
async function classifyBatch(
  batch: CandidateMessage[],
): Promise<ClassifyResult[] | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (batch.length === 0) return [];

  const userPrompt = buildBatchUserPrompt(batch);

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS_PER_BATCH,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const parsed = extractJsonArray(text);
    if (!parsed) {
      console.warn(
        `[nk/classify] Haiku response did not contain a JSON array — falling through to regex fallback (batch size ${batch.length}).`,
      );
      return null;
    }
    const validated = validateBatchResponse(parsed, batch.length);
    if (!validated) {
      console.warn(
        `[nk/classify] Haiku JSON failed validation — falling through to regex fallback (batch size ${batch.length}).`,
      );
      return null;
    }
    return validated;
  } catch (err) {
    console.warn(
      `[nk/classify] Haiku call failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Public entry: classify a flat list of candidates in parallel batches.
 *
 * Returns one ClassifyResult per input candidate, in input order. If
 * Haiku failed for a particular batch the corresponding slots will be
 * filled with a `null` so the caller can route those to the regex
 * fallback path (vs replacing them silently here).
 */
export async function classifyAll(
  candidates: CandidateMessage[],
): Promise<(ClassifyResult | null)[]> {
  if (candidates.length === 0) return [];

  // Split into batches of BATCH_SIZE.
  const batches: CandidateMessage[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push(candidates.slice(i, i + BATCH_SIZE));
  }

  // Fire batches in parallel — Haiku rate limits are generous and a
  // typical cron run produces 10-30 batches.
  const batchResults = await Promise.all(batches.map((b) => classifyBatch(b)));

  // Flatten with null-on-failure preserved per slot.
  const flat: (ClassifyResult | null)[] = [];
  batchResults.forEach((br, batchIdx) => {
    const len = batches[batchIdx].length;
    if (!br) {
      // Whole batch failed — emit nulls so caller can fallback.
      for (let i = 0; i < len; i += 1) flat.push(null);
      return;
    }
    for (const r of br) flat.push(r);
  });

  return flat;
}
