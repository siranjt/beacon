/**
 * Comms sentiment classifier.
 *
 * Falls back to "neutral" when ANTHROPIC_API_KEY is unset — so the scoring
 * pipeline runs cleanly in both states.
 *
 * One Haiku call per entity per day (cached for 30 min within a Node
 * process). Cost shape: ~$0.001 per call × 922 entities = ~$0.92/day.
 *
 * Returns a discrete tone label that downstream code can feed into the
 * Comms signal calculation or surface inline on the customer card.
 */

import { callHaikuJson } from "./llm";

export type CommsTone = "warm" | "neutral" | "frustrated" | "unknown";

const SYSTEM_PROMPT = `You analyze short snippets of business-to-business communication
between a customer-success rep and a small-business owner. You output a single tone label
and a confidence score 0..1. Output STRICT JSON only: {"tone":"warm|neutral|frustrated","confidence":0.0}.

Definitions:
- warm: positive, collaborative, engaged
- neutral: transactional, informational, no strong affect
- frustrated: complaints, escalation, threats, unresponsiveness expressed as anger`;

type SentimentResult = {
  tone: CommsTone;
  confidence: number;
};

const NEUTRAL_FALLBACK: SentimentResult = { tone: "unknown", confidence: 0 };

/**
 * Classify a list of recent message snippets. Concatenates the last N
 * messages with "---" separators; returns a single tone label.
 *
 * Use the last 5-10 messages so the LLM sees both customer and rep voices.
 */
export async function classifyCommsTone(
  recentMessages: string[],
): Promise<SentimentResult> {
  if (!recentMessages || recentMessages.length === 0) {
    return NEUTRAL_FALLBACK;
  }
  // Trim each message to 300 chars to keep input bounded; cap at 10 messages.
  const trimmed = recentMessages
    .slice(-10)
    .map((m) => (m || "").trim().slice(0, 300))
    .filter((m) => m.length > 0);
  if (!trimmed.length) return NEUTRAL_FALLBACK;

  const prompt = `Classify the overall tone of this conversation thread.\n\n---\n${trimmed.join("\n---\n")}\n---\n\nRespond with strict JSON only.`;

  const result = await callHaikuJson<SentimentResult>(
    {
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: 60,
      temperature: 0.1,
    },
    NEUTRAL_FALLBACK,
  );

  // Defensive validation
  if (!["warm", "neutral", "frustrated"].includes(result.tone)) {
    return NEUTRAL_FALLBACK;
  }
  const confidence = Number(result.confidence);
  return {
    tone: result.tone as CommsTone,
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.5,
  };
}
