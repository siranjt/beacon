/**
 * WAVE-B Keeper Question Bank — Haiku question synthesizer.
 *
 * Why this module exists
 * ----------------------
 * The clusterer in question-cluster.ts gives us groups of similar gaps.
 * Each cluster is a real signal — Beam keeps running into the same
 * missing piece of context — but the raw gap descriptions read like
 * fragments ("preferred channel undefined", "no comms cadence", "channel
 * for this customer unknown"). The AM doesn't want a list of fragments;
 * they want one clear question.
 *
 * Haiku turns the cluster into that question. Tight prompt: "Given these
 * gaps the AI couldn't answer, what is the ONE question we should ask
 * the AM that would unblock all of them?" Returns null when the cluster
 * doesn't share a coherent underlying question — better to skip than
 * generate a confused prompt.
 *
 * Cost: ~$0.002 per call. The cron caps total questions per run at 50
 * so worst-case daily spend is $0.10 — comfortably inside the $0.30/mo
 * budget for Wave-B.
 */

import Anthropic from "@anthropic-ai/sdk";

const QUESTION_MODEL =
  process.env.ANTHROPIC_KEEPER_QUESTION_MODEL ?? "claude-haiku-4-5-20251001";

/**
 * Shared client. Soft-fail elsewhere if the key is missing — the
 * generator returns null and the cron skips the cluster.
 */
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

export interface ClusterInput {
  descriptions: string[];
  /**
   * Human-readable scope label — "customer Skin & Tonic Facial Bar" or
   * "AM Sudha's book". Threaded through so Haiku phrases the question
   * naturally ("…about Skin & Tonic" vs "…about Sudha's accounts").
   */
  scope: string;
  /** Matches lib/ai/gaps.ts GapCategory. */
  category: string;
}

export interface GeneratedQuestion {
  question: string;
  confidence: "high" | "medium" | "low";
}

const MAX_QUESTION_WORDS = 60;
const MAX_DESCRIPTIONS = 12;

const SYSTEM_PROMPT = `You are an assistant that synthesizes ONE AM-readable question from a cluster of related "things the AI couldn't answer".

Rules:
- Output strictly one JSON object with this shape: {"question": string, "confidence": "high"|"medium"|"low"}.
- "question" must be ONE natural-language question the Account Manager can answer in 1-2 sentences. Under ${MAX_QUESTION_WORDS} words.
- The question must, if answered, unblock ALL of the listed gaps. If the gaps don't share a clear underlying question, output {"question": null}.
- Confidence:
  - "high" when every gap clearly points at the same missing fact.
  - "medium" when the gaps point at the same TOPIC but have different angles.
  - "low" when the gaps are loosely related; consider returning null instead.
- Speak like an AM colleague, not a robot. No "Please provide…", no "Could you kindly…". Direct, specific, scoped to the customer or book named.
- Do NOT invent facts. Refer only to what's in the gap descriptions.
- Output ONLY the JSON object. No preamble, no markdown fences, no commentary.`;

/**
 * Synthesize one question from one cluster.
 *
 * Returns null when:
 *   - ANTHROPIC_API_KEY is missing
 *   - Haiku explicitly returns {"question": null} (gaps too dispersed)
 *   - Network/parse failure
 *
 * Caller must tolerate null.
 */
export async function generateQuestion(
  cluster: ClusterInput,
): Promise<GeneratedQuestion | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (cluster.descriptions.length === 0) return null;

  // Cap the descriptions we ship — Haiku doesn't need 50 fragments to
  // see a pattern; the first dozen will do and keeps the prompt cheap.
  const trimmed = cluster.descriptions.slice(0, MAX_DESCRIPTIONS);
  const bulletList = trimmed.map((d) => `- ${d}`).join("\n");

  const userPrompt = [
    `Scope: ${cluster.scope}`,
    `Category: ${cluster.category}`,
    "",
    "Gaps Beam encountered repeatedly:",
    bulletList,
    "",
    "Return the single JSON object as instructed.",
  ].join("\n");

  let raw = "";
  try {
    const res = await anthropic.messages.create({
      model: QUESTION_MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
    raw = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[keeper-question] Haiku call failed: ${msg}`);
    return null;
  }

  // Lenient JSON extraction — Haiku sometimes wraps the object in
  // markdown fences or chats around it even when instructed not to.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }

  let parsed: { question?: unknown; confidence?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }

  // Explicit null question → cluster doesn't have a clear question.
  if (parsed.question === null) return null;
  if (typeof parsed.question !== "string") return null;

  const question = parsed.question.trim();
  if (!question) return null;
  if (countWords(question) > MAX_QUESTION_WORDS + 5) {
    // Allow a small overshoot, but reject runaway generations.
    return null;
  }

  const conf =
    parsed.confidence === "high" ||
    parsed.confidence === "medium" ||
    parsed.confidence === "low"
      ? parsed.confidence
      : "medium";

  return { question, confidence: conf };
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}
