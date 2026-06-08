/**
 * Negative Keyword Beacon — keyword pre-screen. Phase NK-2.3.
 *
 * Stage 1 of the two-stage classifier from the doc. The role is the
 * "cheap gate" — broad negative-sentiment lexicon scans each AI-eligible
 * message and only matches advance to the AI stage. This caps Haiku
 * spend and latency on the full-volume comms stream.
 *
 * Pre-screen rules (per doc §8.1):
 *   - App Chat / Email / SMS  → matched candidates go to AI classifier.
 *   - Phone                   → keyword-matched candidates are kept as
 *                                `Flagged` directly (no AI — transcripts
 *                                are too noisy + variable for reliable
 *                                Haiku classification, and the team
 *                                already gets call-outcome notes
 *                                elsewhere).
 *   - Video                   → never directly added. They become
 *                                `Flagged` context ONLY for entities
 *                                that already have another alert in the
 *                                window. That join happens in the cron
 *                                orchestrator, not here.
 *
 * Lexicon design notes:
 *   - Intentionally broad. False positives are cheaper than false
 *     negatives at this stage — Haiku is the expensive filter that
 *     drops the FPs.
 *   - Lowercase comparison, word-boundary aware where it matters
 *     (don't match "rancid" on "cancel"; don't match "unsubscribe" inside
 *     the word "unsubscribed" — actually we DO want that, see the regex).
 *   - Hardcoded here for v1. If maintenance becomes a problem we move
 *     to `lib/negative-keyword/lexicon.json` and load at startup.
 */

import type { CandidateMessage, AlertSource } from "./types";

/**
 * Negative-signal lexicon. Each entry is a case-insensitive regex.
 * Grouped by intent for readability — order doesn't matter, any single
 * match advances the candidate.
 */
const LEXICON: RegExp[] = [
  // Cancellation / leave intent
  /\bcancel(l|led|ling|lation)?\b/i,
  /\bterminat(e|ed|ing|ion)\b/i,
  /\bunsubscrib(e|ed|ing)\b/i,
  /\bopt[\s-]?out\b/i,
  /\bend\s+(my\s+)?(subscription|service|account)\b/i,
  /\bstop\s+(the\s+)?(service|subscription|billing)\b/i,
  /\bdiscontinue\b/i,
  /\bswitch(ing)?\s+(provider|platform|to)\b/i,
  /\bremov(e|ing)\s+(my|the)\s+(account|profile|listing|name)\b/i,

  // Billing / refund / dispute
  /\brefund/i,
  /\bcharg(e|ed|ing|eback|e-back)\b/i,
  /\bbilling\s+(issue|error|problem)\b/i,
  /\binvoice\s+(issue|wrong|incorrect|dispute)\b/i,
  /\bdispute/i,
  /\bbank/i,
  /\bdouble[\s-]?charg(e|ed|ing)\b/i,
  /\bunauthoriz(e|ed)/i,
  /\boverbill(ed|ing)?\b/i,

  // Lead / booking quality
  /\bno\s+(leads?|bookings?|results?|clients?|customers?)\b/i,
  /\bzero\s+(leads?|bookings?|clients?)\b/i,
  /\bnot\s+(getting|seeing|receiving)\s+(leads?|bookings?|results?)\b/i,
  /\bspam\s+(leads?|calls?)\b/i,
  /\bfake\s+leads?\b/i,
  /\bjunk\s+leads?\b/i,
  /\bunqualified\b/i,
  /\bbad\s+leads?\b/i,
  /\bROI\b/i,

  // Technical / broken
  /\bnot\s+working\b/i,
  /\bdoesn'?t\s+work\b/i,
  /\bbroken\b/i,
  /\bbug(s|gy)?\b/i,
  /\berror(s)?\b/i,
  /\bglitch/i,
  /\bcan'?t\s+(see|access|use|log|open|login|sign)\b/i,
  /\bnot\s+loading\b/i,

  // Disappointment / frustration
  /\bdisappoint(ed|ing|ment)?\b/i,
  /\bfrustrat(ed|ing)\b/i,
  /\bupset\b/i,
  /\bangry\b/i,
  /\bterrible\b/i,
  /\bworst\b/i,
  /\bunacceptable\b/i,
  /\bridiculous\b/i,
  /\bawful\b/i,
  /\bwaste\b/i,
  /\bpoor\s+(service|quality|experience)\b/i,
  /\bcomplain(t|ts|ing)?\b/i,
  /\bscam\b/i,

  // Soft churn signals
  /\bthinking\s+(about|of)\s+(cancel|leav|switch)/i,
  /\bconsider(ing)?\s+(cancel|leav|switch)/i,
  /\bmight\s+(cancel|leav|switch)/i,
];

/** Channels whose messages are eligible for Haiku classification. */
const AI_CHANNELS: ReadonlySet<AlertSource> = new Set<AlertSource>([
  "App Chat",
  "Email",
  "SMS",
]);

/** Channels whose matches go directly to `Flagged` (no Haiku). */
const FLAG_ONLY_CHANNELS: ReadonlySet<AlertSource> = new Set<AlertSource>([
  "Phone",
]);

/**
 * Pre-screen result classifies each candidate into:
 *   - aiCandidates  → keyword-matched + Haiku-eligible channel
 *   - flagCandidates → keyword-matched + Flag-only channel (Phone)
 *   - videoCandidates → all Video messages (decided in cron whether to keep)
 *
 * Messages that don't match the lexicon AND aren't Video are dropped.
 */
export interface PrescreenResult {
  aiCandidates: CandidateMessage[];
  flagCandidates: CandidateMessage[];
  videoCandidates: CandidateMessage[];
}

/**
 * Single-message lexicon check. Exported for unit testing.
 */
export function matchesNegativeLexicon(text: string): boolean {
  if (!text) return false;
  for (const rx of LEXICON) {
    if (rx.test(text)) return true;
  }
  return false;
}

/**
 * Apply the channel-aware pre-screen to a customer's candidate stream.
 *
 * Phone/Chat/Email/SMS without a lexicon hit are silently dropped. Video
 * is always kept here (filtered later in the cron based on whether the
 * entity has another alert in the window).
 *
 * Out-bound messages (Zoca → customer) are kept in the screen on purpose
 * — the team's outbound copy occasionally contains the customer's
 * verbatim complaint as a quote, and we want to catch that. Haiku's
 * classifier will handle the "is this customer-originated negative
 * sentiment?" question downstream.
 */
export function prescreen(candidates: CandidateMessage[]): PrescreenResult {
  const result: PrescreenResult = {
    aiCandidates: [],
    flagCandidates: [],
    videoCandidates: [],
  };

  for (const c of candidates) {
    if (c.source === "Video") {
      // Video has no body — keep all for the entity-cross-reference
      // pass that the cron does later.
      result.videoCandidates.push(c);
      continue;
    }

    if (!c.body_available || !c.message_body) {
      // No transcript → can't pre-screen. Phone without transcript drops;
      // there's nothing useful to flag from a metadata-only call.
      continue;
    }

    if (!matchesNegativeLexicon(c.message_body)) continue;

    if (AI_CHANNELS.has(c.source)) {
      result.aiCandidates.push(c);
    } else if (FLAG_ONLY_CHANNELS.has(c.source)) {
      result.flagCandidates.push(c);
    }
    // Otherwise drop — shouldn't happen given the AlertSource union.
  }

  return result;
}
