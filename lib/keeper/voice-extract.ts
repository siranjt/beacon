/**
 * voice-extract — Wave C server module.
 *
 * Why: AMs can now teach the Keeper a fact by SPEAKING (KeeperMicButton /
 * BeamMicButton). The browser does the STT for free, but the resulting
 * transcript is loose, often run-on, and not classified into the Keeper
 * taxonomy. This module asks Haiku to turn one transcript into a single
 * structured-fact DRAFT — topic_category / topic_subcategory / field_name
 * / value / confidence — that the UI shows in a confirm card before any
 * write hits Postgres.
 *
 * Why ONE fact (not a list): voice teach is interactive. Returning a card,
 * letting the AM tweak the field, then writing keeps the trust model tight.
 * If they want to teach three facts they'll record three times. The
 * write-path is still the existing add_fact_to_brain tool, so all source
 * provenance + semantic-dedup behavior stays consistent.
 *
 * Why soft-fail: Haiku flakes occasionally (rate limit, weird JSON, model
 * refusal). Soft-failing to `{ unparseable: true }` keeps the UI honest —
 * the AM sees "couldn't parse" and can re-record, instead of getting a 500.
 *
 * Why no DB / Voyage here: this module only EXTRACTS. The actual write goes
 * through writeBrainFact in lib/brain/repo.ts, which already runs the
 * embedding + conflict gate. Voice extract just produces a candidate draft.
 */

import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import {
  FIELD_CATALOG,
  categoryForSubcategory,
  isNamedField,
} from "@/lib/brain/types";
import type {
  TopicCategory,
  TopicSubcategory,
} from "@/lib/brain/types";

/**
 * Optional context Haiku gets passed so its classification picks up the
 * customer name. Drives copy-quality but doesn't change the taxonomy.
 */
export interface VoiceExtractCustomerContext {
  /** Chargebee-resolved bizname; appears in the prompt so Haiku can ground. */
  bizname?: string | null;
  /** AM's email (for prompt context only — not stored here). */
  am_email?: string | null;
}

export interface VoiceFactDraft {
  unparseable?: false;
  topic_category: TopicCategory;
  topic_subcategory: TopicSubcategory;
  field_name: string;
  value: string;
  /** Haiku-reported confidence in its own classification, ternary scale. */
  confidence: "high" | "medium" | "low";
}

export interface VoiceFactUnparseable {
  unparseable: true;
  reason: string;
}

export type VoiceExtractResult = VoiceFactDraft | VoiceFactUnparseable;

const MODEL =
  process.env.ANTHROPIC_KEEPER_VOICE_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 600;
const MIN_TRANSCRIPT_CHARS = 4;
const MAX_TRANSCRIPT_CHARS = 4000;

const ALL_SUBCATEGORIES: ReadonlySet<TopicSubcategory> = new Set(
  Object.keys(FIELD_CATALOG) as TopicSubcategory[],
);

/**
 * The categories the model is allowed to pick from. We mirror the
 * add_fact_to_brain tool exactly so voice-teach drafts can be written via
 * the same write path (writeBrainFact) without surprises. relationship
 * lives behind its own subcategories that already category-derive, but
 * the top-level enum here matches what the tool accepts.
 */
const ALL_CATEGORIES: ReadonlySet<TopicCategory> = new Set<TopicCategory>([
  "identity",
  "operational",
  "behavioral",
  "concerns",
  "relationship",
]);

/**
 * Stringify FIELD_CATALOG for the prompt. Same shape as add-fact-to-brain
 * tool description so Haiku's classification is consistent across surfaces.
 */
function describeFieldCatalog(): string {
  const lines: string[] = [];
  for (const sub of Object.keys(FIELD_CATALOG) as TopicSubcategory[]) {
    const entry = FIELD_CATALOG[sub];
    lines.push(
      `  - ${entry.category}/${sub}: ${entry.named_fields.join(", ")}, or "other"`,
    );
  }
  return lines.join("\n");
}

function buildSystemPrompt(): string {
  return [
    "You are the Keeper voice-extract classifier. The Account Manager spoke",
    "ONE short sentence (or two) about a customer. Your job is to classify",
    "that utterance into the Keeper taxonomy and propose ONE structured",
    "fact draft. The AM will see your proposal in a confirm card before",
    "anything is saved — so you optimize for accurate classification, not",
    "for boldness. When unsure, lean toward field_name='other' under the",
    "closest-fitting subcategory rather than inventing a named field.",
    "",
    "Taxonomy (subcategory's category prefix shown for reference):",
    describeFieldCatalog(),
    "",
    "Rules:",
    "  1. Pick the subcategory that best matches the utterance's intent.",
    "  2. field_name MUST be a named field for the chosen subcategory OR",
    "     the literal string 'other'. Never invent field names.",
    "  3. topic_category MUST match the subcategory's category prefix.",
    "  4. value is the utterance, lightly normalized: strip 'remember',",
    "     'save', 'note that', leading filler. Preserve names, dates,",
    "     channels, dollar amounts, platform names verbatim.",
    "  5. confidence: 'high' when the utterance maps cleanly to a named",
    "     field; 'medium' when you used 'other' but the subcategory is",
    "     clear; 'low' when the subcategory itself was a coin flip.",
    "  6. Do NOT special-case PII, passwords, or sensitive content —",
    "     just classify what was said. The Validate inbox handles review.",
    "",
    "Respond ONLY with a JSON object — no prose, no markdown fence — with",
    "this exact shape:",
    "  { \"topic_category\": \"...\",",
    "    \"topic_subcategory\": \"...\",",
    "    \"field_name\": \"...\",",
    "    \"value\": \"...\",",
    "    \"confidence\": \"high\" | \"medium\" | \"low\" }",
    "",
    "If the transcript is gibberish, empty, or has no extractable fact,",
    "respond with:",
    "  { \"unparseable\": true, \"reason\": \"<short reason>\" }",
  ].join("\n");
}

function buildUserPrompt(
  transcript: string,
  ctx: VoiceExtractCustomerContext,
): string {
  const lines: string[] = [];
  if (ctx.bizname) {
    lines.push(`Customer: ${ctx.bizname}`);
  }
  lines.push("Transcript:");
  lines.push(transcript);
  return lines.join("\n");
}

/**
 * Strip a markdown code-fence if the model ignored instructions and wrapped
 * the JSON. Keeps the parser robust without changing the system prompt.
 */
function stripFence(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
  }
  return trimmed;
}

/**
 * Validate + narrow Haiku's raw JSON into a typed VoiceExtractResult.
 * Returns null on any structural mismatch so the caller can soft-fail.
 */
function coerceResponse(raw: unknown): VoiceExtractResult | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (obj.unparseable === true) {
    const reason = typeof obj.reason === "string" ? obj.reason : "no_reason";
    return { unparseable: true, reason };
  }

  const cat = obj.topic_category;
  const sub = obj.topic_subcategory;
  const field = obj.field_name;
  const value = obj.value;
  const confidence = obj.confidence;

  if (
    typeof cat !== "string" ||
    typeof sub !== "string" ||
    typeof field !== "string" ||
    typeof value !== "string"
  ) {
    return null;
  }

  if (!ALL_CATEGORIES.has(cat as TopicCategory)) return null;
  if (!ALL_SUBCATEGORIES.has(sub as TopicSubcategory)) return null;

  const expected = categoryForSubcategory(sub as TopicSubcategory);
  // If the model picks a category that doesn't match the subcategory, trust
  // the subcategory (it's the more specific signal).
  const finalCategory = expected;

  if (field !== "other" && !isNamedField(sub as TopicSubcategory, field)) {
    // Unknown named field — coerce to "other" rather than reject outright.
    return {
      topic_category: finalCategory,
      topic_subcategory: sub as TopicSubcategory,
      field_name: "other",
      value: value.trim(),
      confidence: normalizeConfidence(confidence),
    };
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) return null;

  return {
    topic_category: finalCategory,
    topic_subcategory: sub as TopicSubcategory,
    field_name: field,
    value: trimmedValue,
    confidence: normalizeConfidence(confidence),
  };
}

function normalizeConfidence(c: unknown): "high" | "medium" | "low" {
  if (c === "high" || c === "medium" || c === "low") return c;
  return "medium";
}

/**
 * Extract a single Keeper fact draft from a voice transcript.
 *
 * Soft-fails to `{ unparseable: true, reason }` on:
 *   - empty / too-short transcript
 *   - Anthropic SDK error or missing API key
 *   - malformed JSON response
 *   - failed coercion (unknown subcategory etc.)
 */
export async function extractFactFromTranscript(
  transcript: string,
  customerContext: VoiceExtractCustomerContext = {},
): Promise<VoiceExtractResult> {
  const cleaned = (transcript ?? "").trim();
  if (cleaned.length < MIN_TRANSCRIPT_CHARS) {
    return { unparseable: true, reason: "transcript_too_short" };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { unparseable: true, reason: "anthropic_api_key_missing" };
  }

  const truncated = cleaned.slice(0, MAX_TRANSCRIPT_CHARS);

  let textResponse = "";
  try {
    const client = new Anthropic({ apiKey, maxRetries: 2 });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(),
      messages: [
        {
          role: "user",
          content: buildUserPrompt(truncated, customerContext),
        },
      ],
    });
    for (const block of resp.content) {
      if (block.type === "text") textResponse += block.text;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { unparseable: true, reason: `anthropic_error:${msg.slice(0, 80)}` };
  }

  const stripped = stripFence(textResponse);
  if (!stripped) {
    return { unparseable: true, reason: "empty_response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { unparseable: true, reason: "invalid_json" };
  }

  const coerced = coerceResponse(parsed);
  if (!coerced) {
    return { unparseable: true, reason: "unrecognized_shape" };
  }
  return coerced;
}
