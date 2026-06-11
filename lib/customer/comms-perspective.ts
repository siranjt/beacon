/**
 * Phase E-18 — Haiku-derived comms perspective.
 *
 * Reads a `CommsFeedRow[]` (typically last 90 days for one entity) and
 * produces a structured perspective the rest of the app can render
 * everywhere (chips, panels, AI citations). Output schema mirrors the
 * `beacon_ai_comms_perspective` table 1:1 — the store layer UPSERTs the
 * exact shape returned here.
 *
 * Contract:
 *   - Output is ALWAYS a valid `CommsPerspective`. If Haiku errors, JSON
 *     is malformed, or the API key is missing, we fall back to a neutral
 *     default so downstream renderers never see null. The store still
 *     persists this default so we don't hammer Haiku every page-load on a
 *     thin entity.
 *   - One retry on a bad-JSON / bad-shape response. After that, neutral.
 *   - Token budget capped via the rendering helper — 90 days of comms can
 *     be thousands of messages; we cap at the most-recent ~200 and clip
 *     each body to 400 chars.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { CommsFeedRow, CommsFeedChannel } from "./comms-feed-v2";
// META-A5 — spend instrumentation.
import { logSpend, extractUsage } from "@/lib/ai/spend-log";

export type Sentiment = "warm" | "neutral" | "tense" | "escalating";
export type InitiatorPattern = "mostly_us" | "mostly_them" | "balanced";

export interface SentimentEvidence {
  snippet: string;
  source_id: string;
  why: string;
}

export interface ConversationArc {
  start_iso: string;
  peak_iso: string;
  end_iso: string;
  topic: string;
  resolved: boolean;
}

export interface CommsPerspective {
  message_count: number;
  channel_mix: Record<CommsFeedChannel, number>;
  direction_mix: { inbound: number; outbound: number; system: number };
  sentiment: Sentiment;
  sentiment_evidence: SentimentEvidence[];
  topics: string[];
  substance_score: number;
  initiator_pattern: InitiatorPattern;
  response_latency_hours: number | null;
  conversation_arcs: ConversationArc[];
  haiku_summary: string;
}

const PERSPECTIVE_MODEL =
  process.env.ANTHROPIC_PERSPECTIVE_MODEL ?? "claude-haiku-4-5-20251001";
const PERSPECTIVE_MAX_TOKENS = 1500;
const RENDER_MESSAGE_CAP = 200;
const BODY_CHAR_CAP = 400;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

/**
 * Canonical Haiku system prompt.
 *
 * Output contract is STRICT JSON, no prose. The shape below is what the
 * store layer expects and the table schema enforces. If the shape drifts,
 * `validatePerspective()` will reject and we'll retry once.
 */
export const PERSPECTIVE_SYSTEM_PROMPT = `You are analyzing 90 days of customer communications between a Zoca account-management team and a beauty/wellness business owner. Produce a single structured perspective in STRICT JSON.

Output ONLY a JSON object — no prose, no markdown fences, no preamble. Schema:

{
  "sentiment": "warm" | "neutral" | "tense" | "escalating",
  "sentiment_evidence": [
    { "snippet": "<≤140 char quote from a message>", "source_id": "<source_id from the feed>", "why": "<short reason this snippet evidences the sentiment>" }
  ],
  "topics": ["billing", "onboarding", ...],   // 3-5 short noun-phrase topics, lower-case
  "substance_score": 0-100,                   // 100 = every exchange is dense + actionable; 0 = pure ping/ack noise
  "initiator_pattern": "mostly_us" | "mostly_them" | "balanced",
  "response_latency_hours": <number or null>, // our median hours to respond when they message in; null when undeterminable
  "conversation_arcs": [
    { "start_iso": "...", "peak_iso": "...", "end_iso": "...", "topic": "<short>", "resolved": true|false }
  ],                                          // 0-3 arcs — multi-touch threads that opened, peaked, then closed/stalled
  "haiku_summary": "<2-3 sentence narrative — what's actually going on in plain English, no buzzwords>"
}

Rules:
- sentiment: warm = friendly, collaborative; neutral = transactional, low-affect; tense = frustration without escalation; escalating = explicit threats / churn signals / demand-for-action.
- sentiment_evidence: 1-3 entries that DIRECTLY back the sentiment label. Use real source_id values from the feed; never invent.
- topics: domain nouns ("billing", "no-shows", "google-reviews", "onboarding-blockers"). Avoid generic words ("communication", "questions").
- substance_score reflects density. Lots of "ok thanks" messages → low. Detailed feedback / problem descriptions / planning → high.
- initiator_pattern: "mostly_us" = ≥65% messages outbound. "mostly_them" = ≥65% inbound. Else balanced.
- response_latency_hours: median hours between an inbound message and our next outbound. Round to one decimal. null when we have <3 paired exchanges.
- conversation_arcs: only include arcs you can clearly see — a thread that spans ≥3 messages on the same topic over ≥1 day. Skip if the feed is too sparse.
- haiku_summary is what an AM would tell a peer in 10 seconds — concrete, specific, no "the customer seems happy" hedging.

Be conservative. If the feed is sparse (<10 messages), return {sentiment: "neutral", topics: [], substance_score: 50, conversation_arcs: [], …} with an honest haiku_summary explaining the thinness.`;

function emptyChannelMix(): Record<CommsFeedChannel, number> {
  return { chat: 0, email: 0, phone: 0, video: 0, sms: 0 };
}

/** Compute the deterministic numbers + the user-prompt text Haiku reads. */
function buildPromptAndCounts(rows: CommsFeedRow[]): {
  userPrompt: string;
  channel_mix: Record<CommsFeedChannel, number>;
  direction_mix: { inbound: number; outbound: number; system: number };
} {
  const channel_mix = emptyChannelMix();
  const direction_mix = { inbound: 0, outbound: 0, system: 0 };
  for (const r of rows) {
    channel_mix[r.channel] += 1;
    direction_mix[r.direction] += 1;
  }
  // Use the most-recent N for the prompt body; counts above use the full set.
  const sample = rows.slice(0, RENDER_MESSAGE_CAP);
  const lines: string[] = [];
  for (const r of sample) {
    const body =
      r.message_body.length > BODY_CHAR_CAP
        ? r.message_body.slice(0, BODY_CHAR_CAP) + "…"
        : r.message_body;
    const date = r.created_at.slice(0, 10);
    lines.push(
      `[${date}] [${r.channel}/${r.direction}] (src=${r.source_id}) ${r.sender_name}: ${body.replace(/\s+/g, " ").trim()}`,
    );
  }
  const headerLine = `Counts — total ${rows.length} messages over the window. Channel mix: ${JSON.stringify(channel_mix)}. Direction mix: ${JSON.stringify(direction_mix)}.`;
  const userPrompt = `${headerLine}\n\nRecent comms (newest first, up to ${RENDER_MESSAGE_CAP} of ${rows.length}):\n\n${lines.join("\n")}`;
  return { userPrompt, channel_mix, direction_mix };
}

function isSentiment(v: unknown): v is Sentiment {
  return v === "warm" || v === "neutral" || v === "tense" || v === "escalating";
}

function isInitiator(v: unknown): v is InitiatorPattern {
  return v === "mostly_us" || v === "mostly_them" || v === "balanced";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
    .slice(0, 5);
}

function asEvidenceArray(v: unknown): SentimentEvidence[] {
  if (!Array.isArray(v)) return [];
  const out: SentimentEvidence[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const snippet = typeof r.snippet === "string" ? r.snippet.slice(0, 200) : "";
    const source_id = typeof r.source_id === "string" ? r.source_id : "";
    const why = typeof r.why === "string" ? r.why.slice(0, 200) : "";
    if (!snippet) continue;
    out.push({ snippet, source_id, why });
    if (out.length >= 5) break;
  }
  return out;
}

function asArcs(v: unknown): ConversationArc[] {
  if (!Array.isArray(v)) return [];
  const out: ConversationArc[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const start_iso = typeof r.start_iso === "string" ? r.start_iso : null;
    const peak_iso = typeof r.peak_iso === "string" ? r.peak_iso : null;
    const end_iso = typeof r.end_iso === "string" ? r.end_iso : null;
    const topic = typeof r.topic === "string" ? r.topic : null;
    if (!start_iso || !peak_iso || !end_iso || !topic) continue;
    out.push({
      start_iso,
      peak_iso,
      end_iso,
      topic,
      resolved: r.resolved === true,
    });
    if (out.length >= 3) break;
  }
  return out;
}

function asNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.round(v * 10) / 10;
  }
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n * 10) / 10;
  }
  return null;
}

function validatePerspective(
  parsed: unknown,
  counts: {
    message_count: number;
    channel_mix: Record<CommsFeedChannel, number>;
    direction_mix: { inbound: number; outbound: number; system: number };
  },
): CommsPerspective | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (!isSentiment(p.sentiment)) return null;
  if (!isInitiator(p.initiator_pattern)) return null;
  const substance =
    typeof p.substance_score === "number"
      ? Math.max(0, Math.min(100, Math.round(p.substance_score)))
      : NaN;
  if (!Number.isFinite(substance)) return null;
  const haiku = typeof p.haiku_summary === "string" ? p.haiku_summary.trim() : "";
  if (!haiku) return null;
  return {
    message_count: counts.message_count,
    channel_mix: counts.channel_mix,
    direction_mix: counts.direction_mix,
    sentiment: p.sentiment,
    sentiment_evidence: asEvidenceArray(p.sentiment_evidence),
    topics: asStringArray(p.topics),
    substance_score: substance,
    initiator_pattern: p.initiator_pattern,
    response_latency_hours: asNullableNumber(p.response_latency_hours),
    conversation_arcs: asArcs(p.conversation_arcs),
    haiku_summary: haiku.slice(0, 600),
  };
}

function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Neutral fallback when Haiku is unavailable or returns malformed JSON.
 *  Computed numbers are preserved; qualitative fields default safe. */
export function neutralPerspective(rows: CommsFeedRow[]): CommsPerspective {
  const channel_mix = emptyChannelMix();
  const direction_mix = { inbound: 0, outbound: 0, system: 0 };
  for (const r of rows) {
    channel_mix[r.channel] += 1;
    direction_mix[r.direction] += 1;
  }
  return {
    message_count: rows.length,
    channel_mix,
    direction_mix,
    sentiment: "neutral",
    sentiment_evidence: [],
    topics: [],
    substance_score: 50,
    initiator_pattern: "balanced",
    response_latency_hours: null,
    conversation_arcs: [],
    haiku_summary:
      rows.length === 0
        ? "No comms in the last 90 days — nothing to summarize."
        : "Perspective not yet computed for this customer.",
  };
}

async function callHaikuOnce(
  systemPrompt: string,
  userPrompt: string,
): Promise<unknown | null> {
  const res = await anthropic.messages.create({
    model: PERSPECTIVE_MODEL,
    max_tokens: PERSPECTIVE_MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  // META-A5 — comms-perspective is per-entity; we don't have a useful
  // email/scope to attach here, so we leave them null.
  void logSpend({
    feature: "comms-perspective",
    model: PERSPECTIVE_MODEL,
    ...extractUsage(res),
  });
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
  return extractJson(text);
}

/**
 * Run a Haiku pass over the rows and return a structured perspective.
 * One retry on malformed JSON; neutral fallback otherwise. Always resolves.
 */
export async function buildCommsPerspective(
  rows: CommsFeedRow[],
): Promise<CommsPerspective> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return neutralPerspective(rows);
  }
  const { userPrompt, channel_mix, direction_mix } = buildPromptAndCounts(rows);
  const counts = {
    message_count: rows.length,
    channel_mix,
    direction_mix,
  };

  // Avoid burning tokens on empty feeds — neutral is the honest answer.
  if (rows.length === 0) {
    return neutralPerspective(rows);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const parsed = await callHaikuOnce(PERSPECTIVE_SYSTEM_PROMPT, userPrompt);
      const validated = validatePerspective(parsed, counts);
      if (validated) return validated;
      // Malformed shape — retry once with a tightening reminder appended.
      if (attempt === 0) {
        continue;
      }
    } catch (err) {
      console.warn(
        "[comms-perspective] Haiku call failed:",
        err instanceof Error ? err.message : String(err),
      );
      // Network / SDK error — break out, fall back to neutral.
      break;
    }
  }
  return neutralPerspective(rows);
}
