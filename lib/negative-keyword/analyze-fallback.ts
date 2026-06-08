/**
 * Negative Keyword Beacon — regex fallback classifier. Phase NK-2.5.
 *
 * Ported from the original standalone repo's `app/api/alerts/route.ts`
 * (siranjt/negative-keyword-ticket-generator @ 0e77ca9 on main, April
 * 2026). The shape changed (function names, return types) but the
 * detection logic is preserved verbatim so this path produces the
 * same call when Haiku is unavailable.
 *
 * When this fires:
 *   - ANTHROPIC_API_KEY is unset (any environment without billing).
 *   - Haiku returned malformed JSON twice in a row for a batch.
 *   - Haiku threw twice in a row for a batch.
 *
 * The `classifier` column on the DB row records whether the row came
 * via 'ai' or 'regex-fallback', so we can measure how often we degrade
 * and audit accuracy on each path.
 *
 * Bugs fixed during port (vs original):
 *   - Trim() the message body before parsing — doc spec stayed intact.
 *   - Guard against null/undefined message_body — original would have
 *     thrown on TypeError when reading .replace.
 */

import type { CandidateMessage, RiskCategory } from "./types";

interface ClassifyFallback {
  category: RiskCategory;
  analysis: string;
}

const RISK_MAP: { pattern: RegExp; label: RiskCategory }[] = [
  {
    pattern: /cancel|cancell|remove.*zoca|stop.*service|end.*subscription|terminate/i,
    label: "Cancellation",
  },
  {
    pattern: /refund|charge|money|payment|billing|invoice|chargeback|dispute|took.*money/i,
    label: "Billing",
  },
  {
    pattern: /lead|booking|spam|call.*quality|no.*result|roi/i,
    label: "Lead quality",
  },
  {
    pattern: /not.*work|bug|broken|issue|error|can.*see|glitch/i,
    label: "Technical",
  },
  {
    pattern: /disappoint|upset|unhappy|frustrated|terrible|worst|unacceptable|ridiculous/i,
    label: "Disappointed",
  },
];

function classifyRisk(text: string): RiskCategory {
  const lower = text.toLowerCase();
  for (const r of RISK_MAP) if (r.pattern.test(lower)) return r.label;
  return "Flagged";
}

/**
 * Build a contextual 2-sentence analysis based on intent detection.
 * Ported verbatim from the original `analyze()` heuristic — same intent
 * detection rules and templated copy. Used only when Haiku is offline.
 */
function analyze(c: CandidateMessage): string {
  const raw = (c.message_body || "").trim();
  if (!raw) return "Empty message — flagged on channel + sender context alone.";
  const text = raw.replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  const parts: string[] = [];

  // Detect specific intents (kept aligned with original's analyze()).
  const wantsCancel =
    /cancel|cancell|end.*(?:account|subscription|service)|stop.*(?:service|subscription)|terminate/i.test(
      lower,
    );
  const wantsRefund =
    /refund|money\s*back|took.*money|charge.*back|return.*money|give.*back/i.test(lower);
  const wantsRemoval =
    /remove.*zoca|remove.*(?:my|the)\s*(?:name|listing|account|profile)|take.*(?:down|off)/i.test(
      lower,
    );
  const isUrgent = /immediately|asap|right now|urgent|today|right away/i.test(lower);
  const threatenBank = /call.*bank|dispute.*charge|chargeback|bank.*dispute/i.test(lower);
  const threatenLeave =
    /thinking.*(?:cancel|leav)|might.*(?:cancel|leav)|considering.*(?:cancel|switch)/i.test(lower);
  const noResults =
    /no.*(?:booking|lead|result|client|customer)|zero.*(?:booking|lead)|haven'?t.*(?:got|received|seen).*(?:anyone|anybody|lead|booking)/i.test(
      lower,
    );
  const spamIssue = /spam|unknown.*call|unqualified|junk.*lead|fake.*lead/i.test(lower);
  const notWorking =
    /not.*work|doesn'?t.*work|broken|can'?t.*(?:see|access|use|log|open)|error|glitch|bug/i.test(
      lower,
    );
  const priceIssue = /too.*(?:much|expensive)|overcharg|price|cost|afford/i.test(lower);
  const isStopSMS =
    /^stop$/i.test(raw.trim()) || (lower.includes("stop") && raw.trim().length < 15);
  const wantsListRemoval = /remove.*(?:from|off).*list|unsubscribe|opt.*out/i.test(lower);
  const isDisappointed =
    /disappoint|upset|frustrated|unhappy|angry|terrible|worst|unacceptable|ridiculous/i.test(
      lower,
    );
  const duplicateCharge = /double.*charge|charged.*twice|two.*charge|duplicate.*payment/i.test(lower);
  const missedPayment =
    /took.*(?:money|payment)|charged.*(?:again|already)|still.*(?:charging|taking|billing)|didn'?t.*(?:authorize|approve)/i.test(
      lower,
    );

  const dollarMatch = text.match(/\$[\d,.]+/);
  const amountStr = dollarMatch ? ` (${dollarMatch[0]})` : "";

  if (isStopSMS) {
    parts.push("Customer sent an SMS opt-out signal.");
    parts.push(
      "This may indicate deeper dissatisfaction beyond just SMS preferences — AM should check account health proactively.",
    );
    return parts.join(" ");
  }

  if (wantsListRemoval) {
    parts.push("Customer is requesting to be removed from contact/marketing lists.");
    parts.push(
      "Verify whether this is a simple preference update or signals intent to disengage from Zoca entirely.",
    );
    return parts.join(" ");
  }

  if (wantsCancel) {
    if (wantsRefund) {
      parts.push(`Customer is demanding both cancellation and a refund${amountStr}.`);
      parts.push(
        isUrgent
          ? "Marked as urgent — immediate AM escalation required before the customer initiates a chargeback."
          : "Billing team should process the refund while AM attempts retention.",
      );
    } else if (noResults) {
      parts.push(
        "Customer wants to cancel because they're not seeing results — no bookings or leads being generated.",
      );
      parts.push(
        "AM should present performance data and discuss optimization before processing cancellation.",
      );
    } else if (isUrgent) {
      parts.push("Customer is urgently requesting cancellation and expects same-day action.");
      parts.push(
        "High churn risk — AM needs to reach out immediately, ideally by phone, to understand the root cause.",
      );
    } else {
      parts.push("Customer has expressed intent to cancel their Zoca subscription.");
      parts.push(
        threatenLeave
          ? "Currently weighing the decision — there may be a retention window if AM acts quickly."
          : "AM should initiate a retention call to understand concerns and offer solutions.",
      );
    }
    return parts.join(" ");
  }

  if (wantsRefund || missedPayment || duplicateCharge) {
    if (threatenBank) {
      parts.push(
        `Customer is disputing a charge${amountStr} and threatening to contact their bank for a chargeback.`,
      );
      parts.push(
        "Critical: process refund immediately to avoid a formal dispute which carries additional fees and account risk.",
      );
    } else if (duplicateCharge) {
      parts.push(`Customer reports being double-charged${amountStr}.`);
      parts.push(
        "Billing team should verify transaction history and issue correction promptly — duplicate charges erode trust quickly.",
      );
    } else if (missedPayment) {
      parts.push(
        `Customer says they were charged${amountStr} despite previously requesting service cancellation.`,
      );
      parts.push(
        "This suggests a process failure — verify cancellation was logged and process the refund to maintain goodwill.",
      );
    } else {
      parts.push(`Customer is requesting a refund${amountStr}.`);
      parts.push(
        "AM should review the billing history, understand the complaint, and coordinate with the billing team.",
      );
    }
    return parts.join(" ");
  }

  if (noResults || spamIssue) {
    if (spamIssue) {
      parts.push("Customer is receiving spam or unqualified leads instead of genuine bookings.");
      parts.push(
        "This is a product quality issue — review the Win Agent/lead source configuration and filter settings for this account.",
      );
    } else {
      parts.push("Customer reports zero bookings or leads over a sustained period and is questioning ROI.");
      parts.push(
        "AM should pull the actual performance data, identify any configuration issues, and schedule a strategy review call.",
      );
    }
    if (threatenLeave) {
      parts[1] = parts[1].replace(/\.$/, "") +
        " — customer is considering cancellation if this isn't resolved.";
    }
    return parts.join(" ");
  }

  if (notWorking) {
    parts.push("Customer is reporting a technical issue that's blocking their ability to use Zoca services.");
    parts.push(
      "Escalate to the technical team and confirm resolution with the customer — unresolved tech issues are a leading churn indicator.",
    );
    return parts.join(" ");
  }

  if (wantsRemoval) {
    parts.push("Customer is asking to have Zoca branding or presence removed from their business profile.");
    parts.push(
      "This typically precedes formal cancellation — AM should reach out to understand concerns and explore whether the relationship is salvageable.",
    );
    return parts.join(" ");
  }

  if (isDisappointed) {
    parts.push("Customer is expressing strong dissatisfaction with Zoca's service delivery.");
    parts.push(
      threatenLeave
        ? "Customer is actively considering leaving — this requires urgent AM attention to prevent churn."
        : "AM should schedule a call to address concerns directly and rebuild confidence in the service.",
    );
    return parts.join(" ");
  }

  if (priceIssue) {
    parts.push("Customer has raised concerns about pricing or the cost-to-value ratio of Zoca services.");
    parts.push(
      "AM should review their plan, demonstrate ROI with booking data, and discuss any available pricing options.",
    );
    return parts.join(" ");
  }

  // Generic fallback — extract first meaningful sentence.
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 10);
  const firstMeaningful = sentences[0]?.trim() || text.slice(0, 120);
  parts.push(
    `Message flagged on negative-keyword match: "${firstMeaningful.slice(0, 100)}${
      firstMeaningful.length > 100 ? "..." : ""
    }".`,
  );
  parts.push("AM should review the full context and assess whether intervention is needed.");
  return parts.join(" ");
}

/**
 * Public entry: regex-based classification for a single candidate. The
 * cron uses this when Haiku fails or is unavailable. Returns the same
 * shape as one slot of the Haiku output minus the `index`.
 */
export function classifyFallback(c: CandidateMessage): ClassifyFallback {
  const text = `${c.message_body || ""}`.trim();
  const category = classifyRisk(text);
  const analysis = analyze(c);
  return { category, analysis };
}
