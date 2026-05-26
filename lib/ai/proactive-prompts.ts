/**
 * Phase E-17 Wave 3b — proactive Beacon AI prompts.
 *
 * Two surfaces:
 *   1. Monday morning briefing — "what should I focus on this week?"
 *      Sent every Monday 8am IST to each AM. Top-5 actions for the week.
 *   2. Daily anomaly digest — "what changed in my book overnight?"
 *      Sent daily 8am IST when there are material changes (score drops,
 *      tier flips, new tickets, new missed payments). Skip on quiet days
 *      to avoid noise.
 *
 * These prompts INTENTIONALLY do NOT inherit from `lib/ai/prompts.ts`'s
 * COMMON block. That block is built for the reactive AskPanel surface —
 * citations, tool-use contract, confidence markers. None of that applies
 * here:
 *   - Slack DMs don't render citation chips (they'd render as raw text).
 *   - There are no tools available in a proactive briefing — the AM acts
 *     in their planner, not in Slack.
 *   - Confidence markers belong on individual recommendations, not on a
 *     top-of-week broadcast.
 *
 * What we DO share with the AskPanel:
 *   - The Beacon AI identity ("you're Beacon AI, not Claude").
 *   - The voice register (terse, AM-Slack, no corporate fluff).
 *   - The style-facts injection from lib/ai/facts.ts — Beacon AI should
 *     sound like THIS AM, not a generic broadcast.
 */

const BRIEFING_VOICE = `VOICE & STYLE:
- Terse. This is a Slack DM to an AM, not a report. Match the register of an internal teammate dropping a quick note.
- Slack-markdown only: *bold* (single asterisk, not **), \`inline code\`, > blockquotes. No headings (#).
- No preamble. No "Good morning" / "Hope you're well" / "Here is your briefing". Open with the substance.
- Use bizname as the anchor, never entity_id. Numbers should be concrete (composite 78, 23 days silent, 4 unpaid invoices).
- If the data is thin or quiet, say so honestly in one line ("quiet morning — nothing material moved overnight"). Don't pad.
- Close with one short next step, not a generic sign-off.`;

const BRIEFING_IDENTITY = `You are *Beacon AI* — Zoca's customer-intelligence copilot. You're being run by a scheduled job, not in a chat. The output of this single call goes straight into a Slack DM to a single Zoca account manager. There is no follow-up turn. There is no tool use available here.`;

export type BriefingTopCustomer = {
  bizname: string;
  entity_id: string;
  composite: number;
  stoplight: "RED" | "YELLOW" | "GREEN";
  tier: string;
  days_since_out: number | null;
  reason_one_line: string;
  open_tickets: number;
  unpaid_invoice_count: number;
  trajectory_7d: string | null;
};

export type BookAggregates = {
  total_active: number;
  red_count: number;
  yellow_count: number;
  green_count: number;
};

export interface PromptPair {
  system: string;
  user: string;
}

/**
 * Build a Monday morning briefing prompt. Returns {system, user} for the
 * Anthropic messages.create call.
 */
export function buildMondayBriefingPrompt(
  amName: string,
  topCustomers: BriefingTopCustomer[],
  bookAggregates: BookAggregates,
  factsBlock: string | null,
): PromptPair {
  const styleSection = factsBlock
    ? `THE AM'S WORKING STYLE (apply naturally — don't recite):\n${factsBlock}\n\n`
    : `THE AM'S WORKING STYLE: (none captured yet — default to terse, direct, AM-Slack register)\n\n`;

  const system = `${BRIEFING_IDENTITY}

SURFACE: You are drafting a *Monday morning briefing* for ${amName}, delivered to their Slack DMs at 8am IST. Goal: give them the top 5 customers to focus on this week, with enough context to act, in their preferred voice.

${BRIEFING_VOICE}

OUTPUT SHAPE — exactly this structure, nothing else:
- Line 1: a single greeting line (e.g. "morning ${amName.split(" ")[0]} — 5 to focus on this week.") — no emoji, no "Good morning,".
- Blank line.
- 5 numbered items. Each item: *bizname* on one line, then a single sentence WHY they're priority + one suggested first action. 2 lines per item max.
- Blank line.
- Closing line: ONE sentence about the book's overall trend if notable (RED count vs the rest), else a short prompt to dive in. No sign-off.

${styleSection}HARD RULES:
- Output ONLY the Slack DM body. No preamble, no "Here's your briefing", no markdown code fences.
- Slack-markdown only: single-asterisk *bold*, NOT double-asterisk **bold**. The DM will be sent as-is.
- Do NOT invent customers. The 5 you list MUST come from the JSON below.
- Do NOT include citation chips like [cite:...] — Slack would render them as raw text.
- Do NOT include confidence markers — this is a broadcast, not a recommendation surface.`;

  const customerJson = JSON.stringify(
    topCustomers.map((c, i) => ({
      rank: i + 1,
      bizname: c.bizname,
      composite_score: c.composite,
      stoplight: c.stoplight,
      tier: c.tier,
      days_since_out: c.days_since_out,
      trajectory_7d: c.trajectory_7d ?? "unknown",
      open_tickets: c.open_tickets,
      unpaid_invoice_count: c.unpaid_invoice_count,
      reason_one_line: c.reason_one_line,
    })),
    null,
    2,
  );

  const user = `BOOK SUMMARY for ${amName}:
- Total active customers: ${bookAggregates.total_active}
- RED (needs attention): ${bookAggregates.red_count}
- YELLOW (watching): ${bookAggregates.yellow_count}
- GREEN (healthy): ${bookAggregates.green_count}

TOP 5 customers for this week (sorted worst → least-worst, snoozed + pinned already removed):
${customerJson}

Draft the Monday briefing now. Output ONLY the Slack DM body — no preamble, no fences.`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Daily anomaly digest
// ---------------------------------------------------------------------------

export type DailyChange = {
  bizname: string;
  entity_id: string;
  kind:
    | "score_drop"
    | "tier_flip_worse"
    | "tier_flip_better"
    | "new_ticket"
    | "new_missed_payment";
  /** Human-readable one-line summary of the change. */
  detail: string;
  /** Stoplight today, for grouping/sort. */
  stoplight_today: "RED" | "YELLOW" | "GREEN";
  /** Optional numeric magnitudes for context. */
  composite_today?: number;
  composite_yesterday?: number;
  composite_delta?: number;
};

export type DailyDigestSummary = {
  total_changes: number;
  score_drops: number;
  tier_flips_worse: number;
  tier_flips_better: number;
  new_tickets: number;
  new_missed_payments: number;
  /** True when yesterday's snapshot wasn't found — caller surfaces a first-run notice. */
  no_yesterday_snapshot: boolean;
};

/**
 * Build a daily anomaly digest prompt. Returns {system, user}.
 * Callers should only invoke when summary.total_changes >= 1 or
 * no_yesterday_snapshot is true.
 */
export function buildDailyDigestPrompt(
  amName: string,
  changes: DailyChange[],
  summary: DailyDigestSummary,
  factsBlock: string | null,
): PromptPair {
  const styleSection = factsBlock
    ? `THE AM'S WORKING STYLE (apply naturally — don't recite):\n${factsBlock}\n\n`
    : `THE AM'S WORKING STYLE: (none captured yet — default to terse, direct, AM-Slack register)\n\n`;

  const system = `${BRIEFING_IDENTITY}

SURFACE: You are drafting a *daily anomaly digest* for ${amName}, delivered to their Slack DMs at 8am IST. Goal: tell them what changed in their book overnight, so they can act on the deltas instead of re-scanning the whole list.

${BRIEFING_VOICE}

OUTPUT SHAPE — exactly this structure, nothing else:
- Line 1: a single opener line summarizing the volume of change (e.g. "3 score drops, 1 new ticket overnight — here's the cut."). No greeting.
- Blank line.
- One bullet group per non-zero change category. Group header in *bold* (e.g. "*Score drops:*"), then 1 bullet per affected customer with *bizname* + the delta + a one-line reason.
- Order categories by priority: score_drops, tier_flips_worse, new_missed_payments, new_tickets, then tier_flips_better last as a small "wins" note.
- Blank line.
- Closing line: ONE concrete next action targeting the single highest-priority change ("call <bizname> first — composite dropped 18 points and a ticket landed yesterday"). No sign-off.

${styleSection}HARD RULES:
- Output ONLY the Slack DM body. No preamble, no fences.
- Slack-markdown only: single-asterisk *bold*, NOT double-asterisk **bold**.
- If \`no_yesterday_snapshot\` is true in the summary, replace the body with: "first run — yesterday's snapshot wasn't recorded, so there's nothing to diff against. Full digest tomorrow." Do not invent changes.
- Do NOT invent customers. Only mention bizname values from the JSON below.
- Do NOT include citation chips like [cite:...] — Slack would render them as raw text.
- Do NOT include confidence markers.`;

  const changesJson = JSON.stringify(
    changes.map((c) => ({
      bizname: c.bizname,
      kind: c.kind,
      detail: c.detail,
      stoplight_today: c.stoplight_today,
      composite_today: c.composite_today,
      composite_yesterday: c.composite_yesterday,
      composite_delta: c.composite_delta,
    })),
    null,
    2,
  );

  const user = `SUMMARY of changes for ${amName} (today vs yesterday):
${JSON.stringify(summary, null, 2)}

CHANGES (already filtered to "material" — score drops > 10, tier flips, new tickets in last 24h, new missed payments):
${changesJson}

Draft the daily digest now. Output ONLY the Slack DM body — no preamble, no fences.`;

  return { system, user };
}
