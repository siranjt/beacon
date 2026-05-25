/**
 * Scope discriminated union + URL pathname → scope resolver.
 * Phase E-9 universal AI copilot.
 *
 * Each scope binds the AskPanel to a specific data context so Claude
 * answers grounded in what the user is currently looking at. Scope
 * resolution happens client-side from the URL (cheap, no fetch) and the
 * server re-validates + loads the actual data.
 */

export type AiScope =
  | { kind: "inbox" }
  | { kind: "customer-360"; entityId: string }
  | { kind: "customer-book" }
  | { kind: "performance-landing" }
  | { kind: "performance-report"; entityId: string }
  | { kind: "escalation-overview" }
  | { kind: "post-payment-book" }
  | { kind: "post-payment-customer"; cbCustomerId: string }
  | { kind: "hidden" };

/** Stable string key for each scope (used for analytics + storage). */
export function scopeKey(s: AiScope): string {
  switch (s.kind) {
    case "customer-360":
      return `customer-360:${s.entityId}`;
    case "performance-report":
      return `performance-report:${s.entityId}`;
    case "post-payment-customer":
      return `post-payment-customer:${s.cbCustomerId}`;
    default:
      return s.kind;
  }
}

/**
 * Resolve a pathname to a scope. Returns "hidden" for routes where the
 * panel shouldn't appear (auth, admin, unknown).
 *
 * Order matters — we match the longest specific path first, falling back
 * to broader matches.
 */
export function pathToScope(pathname: string): AiScope {
  // Sign-in / sign-out / auth routes — hide
  if (pathname.startsWith("/auth")) return { kind: "hidden" };
  // Admin surfaces have their own purpose; AI panel would be distracting
  if (pathname.startsWith("/admin")) return { kind: "hidden" };
  // API routes never render the panel
  if (pathname.startsWith("/api")) return { kind: "hidden" };

  // Customer 360 (umbrella unified view)
  const m360 = pathname.match(/^\/360\/([^/]+)/);
  if (m360) return { kind: "customer-360", entityId: m360[1] };

  // Customer Beacon
  if (pathname === "/customer") return { kind: "customer-book" };
  if (pathname.startsWith("/customer/manager")) return { kind: "customer-book" };
  if (pathname.startsWith("/customer/monday")) return { kind: "customer-book" };
  const mCustomer = pathname.match(/^\/customer\/([^/]+)/);
  if (mCustomer) {
    // Treat /customer/{entityId} the same as /360/{entityId} — same view
    // for AI grounding purposes.
    const entityId = mCustomer[1];
    // Skip known sub-routes (manager, monday handled above)
    if (entityId !== "manager" && entityId !== "monday") {
      return { kind: "customer-360", entityId };
    }
    return { kind: "customer-book" };
  }

  // Performance Beacon
  const mPerfReport = pathname.match(/^\/performance\/report\/([^/]+)/);
  if (mPerfReport) {
    return { kind: "performance-report", entityId: mPerfReport[1] };
  }
  if (pathname.startsWith("/performance")) return { kind: "performance-landing" };

  // Escalation Beacon — same scope for home / queue / triage / tickets
  if (pathname.startsWith("/escalation")) return { kind: "escalation-overview" };

  // Post-Payment Reviews
  const mPpReport = pathname.match(/^\/post-payment\/reports\/([^/]+)/);
  if (mPpReport) {
    return { kind: "post-payment-customer", cbCustomerId: mPpReport[1] };
  }
  if (pathname.startsWith("/post-payment")) return { kind: "post-payment-book" };

  // Umbrella launcher
  if (pathname === "/" || pathname === "") return { kind: "inbox" };

  return { kind: "hidden" };
}

/** Human label per scope — used in the AskPanel header + Slack digest. */
export function scopeLabel(s: AiScope): string {
  switch (s.kind) {
    case "inbox":
      return "Today's inbox";
    case "customer-360":
      return "this customer";
    case "customer-book":
      return "your customer book";
    case "performance-landing":
      return "Performance Beacon";
    case "performance-report":
      return "this performance report";
    case "escalation-overview":
      return "the escalation queue";
    case "post-payment-book":
      return "recent post-payment reviews";
    case "post-payment-customer":
      return "this post-payment review";
    case "hidden":
      return "";
  }
}

/** Quick-action prompts per scope. */
export function scopeQuickPrompts(
  s: AiScope,
): Array<{ label: string; prompt: string }> {
  switch (s.kind) {
    case "inbox":
      return [
        {
          label: "What should I focus on first?",
          prompt:
            "Looking at today's inbox, what's the single highest-leverage item I should tackle first? Justify briefly.",
        },
        {
          label: "Summarize my day",
          prompt:
            "Give me a 3-bullet summary of what's on my plate today, ordered by urgency.",
        },
        {
          label: "Any patterns across these items?",
          prompt:
            "Look across all the inbox items — any common themes (e.g. same AM, same signal type, same vertical)? Call out what I should watch.",
        },
        {
          label: "Anything I can safely defer?",
          prompt:
            "Which inbox items can probably wait until next week, and which absolutely cannot? Be direct.",
        },
      ];
    case "customer-360":
      return [
        {
          label: "Why is this customer at this score?",
          prompt:
            "Looking at this customer's signals, what's the single biggest reason their composite score is where it is? Cite specific numbers.",
        },
        {
          label: "Summarize the last 30 days",
          prompt:
            "Give me a 4-bullet summary of what's happened with this customer in the last 30 days — comms, signals, billing, tickets. End with what I should pay attention to.",
        },
        {
          label: "Draft an outreach email",
          prompt:
            "Draft a short, warm-but-direct outreach email I can send this customer's owner today. Use the AM's signature voice. Reference one specific thing from their data so it doesn't feel templated.",
        },
        {
          label: "What should I prioritize?",
          prompt:
            "What are the top 3 things I should do for this customer this week, in priority order? Be specific and actionable.",
        },
      ];
    case "customer-book":
      return [
        {
          label: "Summarize book health",
          prompt:
            "Give me a 3-bullet summary of the current book health: how many RED / YELLOW / GREEN, any concerning patterns, what to watch.",
        },
        {
          label: "Who's regressing fastest?",
          prompt:
            "Which customers have the worst 7-day trajectory? List up to 5 with the specific reason.",
        },
        {
          label: "Who haven't I contacted recently?",
          prompt:
            "Which customers in the book have I (the AM) been silent on for 14+ days? Sort by composite-score risk first.",
        },
        {
          label: "Common patterns across RED?",
          prompt:
            "Look at the RED-stoplight customers — are they failing on the same signal? Suggest a single intervention that could help multiple at once.",
        },
      ];
    case "performance-landing":
      return [
        {
          label: "How does the composite score work?",
          prompt:
            "Explain how Zoca's customer composite score is calculated, in plain English. Include the 50/30/20 comms/usage/billing weights.",
        },
        {
          label: "What's a healthy GBP click trend?",
          prompt:
            "What does a healthy Google Business Profile click trend look like for a Zoca customer? Give numbers if possible.",
        },
        {
          label: "How do keyword rankings get into the report?",
          prompt:
            "Walk me through how the keyword ranking data flows into a Performance Beacon report. Where does it come from, how is it scored?",
        },
      ];
    case "performance-report":
      return [
        {
          label: "What's the biggest concern here?",
          prompt:
            "Looking at this performance report, what's the single biggest concern? Cite specific metrics.",
        },
        {
          label: "Are leads on track?",
          prompt:
            "Compare YTD leads to the 6-month prediction. Is this customer on track or off? By how much?",
        },
        {
          label: "Highlight the wins",
          prompt:
            "What's going well in this performance report? Give me 2-3 concrete wins I can share with the customer.",
        },
        {
          label: "Drafts a check-in message",
          prompt:
            "Draft a 4-line check-in message I can send this customer summarizing their performance this month. Lead with one win, then the area to focus on next.",
        },
      ];
    case "escalation-overview":
      return [
        {
          label: "Prioritize the queue",
          prompt:
            "Looking at the open ticket queue, what should the team tackle first? Reason about age + customer health + ticket category.",
        },
        {
          label: "Which AM has the most open tickets?",
          prompt:
            "Which account managers have the most open tickets right now? Are any AMs notably underwater?",
        },
        {
          label: "Trends this week?",
          prompt:
            "Look at the tickets opened in the last 7 days. Any pattern — same root cause, same customer segment, same ticket type?",
        },
        {
          label: "Any old open tickets?",
          prompt:
            "Are there any open tickets older than 14 days? Surface them — they're likely stalled.",
        },
      ];
    case "post-payment-book":
      return [
        {
          label: "Summarize this week's verdicts",
          prompt:
            "Summarize the post-payment verdicts from the last 7 days. How many ICP / Review / Not ICP? Any standouts?",
        },
        {
          label: "Who needs AM follow-up?",
          prompt:
            "Which post-payment customers have needs_am_call = true and haven't been actioned? List them in priority order.",
        },
        {
          label: "Common reasons for Not ICP?",
          prompt:
            "Look at recent Not ICP verdicts. What are the most common reasons cited? Identify the top 2-3 patterns.",
        },
        {
          label: "Stuck or failed analyses?",
          prompt:
            "Are any post-payment analyses stuck in 'processing' or failed? List them with timestamps.",
        },
      ];
    case "post-payment-customer":
      return [
        {
          label: "Walk me through this verdict",
          prompt:
            "Walk me through how this verdict was reached. What were the key signals and which Module 02 rules applied?",
        },
        {
          label: "Should I push back on this verdict?",
          prompt:
            "Looking at the data, is there a reasonable case for a different verdict? Argue against the current one if you can.",
        },
        {
          label: "What action does the AM need to take?",
          prompt:
            "What's the concrete next step for the AM on this customer? Give me a specific action, timeline, and success criterion.",
        },
        {
          label: "Draft a customer reply",
          prompt:
            "Draft a short message to this customer's owner that addresses the key concern surfaced in this verdict. Be honest and direct.",
        },
      ];
    case "hidden":
      return [];
  }
}
