/**
 * Umbrella-wide config. As agents are migrated in Phase B/C/D, their per-agent
 * config moves into their respective `app/(agent)/_lib/config.ts` files. This
 * file is reserved for genuinely shared concerns: auth allowlist, agent
 * directory, brand tokens.
 */

/**
 * Email domains allowed to sign in. Anyone outside these is rejected by the
 * NextAuth signIn callback. Source of truth — change here, propagates to all
 * agents.
 */
export const ALLOWED_EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || "zoca.com,zoca.ai")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const [, domain] = email.toLowerCase().split("@");
  if (!domain) return false;
  return ALLOWED_EMAIL_DOMAINS.includes(domain);
}

/**
 * The agents under the umbrella. Order here = order in the launcher.
 *
 * `kind: "internal"` — the agent has been migrated into the umbrella; route
 *                      points to a local path like `/customer`.
 * `kind: "external"` — agent still lives in its standalone deployment; route
 *                      points to the standalone URL. Click opens in same tab.
 *
 * As each phase ships, flip `kind` from "external" to "internal" + update
 * `route` to the local path.
 */
export type AgentKind = "internal" | "external";
export type AgentId =
  | "customer"
  | "performance"
  | "escalation"
  | "post-payment"
  | "miss-payment"
  | "negative-keyword";
export type Agent = {
  id: AgentId;
  name: string;
  description: string;
  accent: string;       // Watchfire accent color for the card
  route: string;        // local path or external URL depending on `kind`
  kind: AgentKind;
};

/**
 * Agents currently locked behind a "will be operational shortly" curtain for
 * everyone (admins included). The route-group layouts intercept page routes
 * and render `<MaintenanceCurtain />` instead of letting users in. Launcher
 * cards visually disable + skip navigation.
 *
 * API routes under these agents stay reachable so webhooks (Stripe → Post-
 * Payment) and internal cross-agent calls don't break.
 *
 * To unlock: drop the entry from this set. To lock another agent: add its
 * AgentId, then create `app/(<agent>)/layout.tsx` that re-renders
 * MaintenanceCurtain when the flag is on.
 */
export const LOCKED_AGENTS = new Set<AgentId>([
  "performance",
  "post-payment",
]);

export function isAgentLocked(id: AgentId): boolean {
  return LOCKED_AGENTS.has(id);
}

export const AGENTS: Agent[] = [
  {
    id: "customer",
    name: "Customer Beacon",
    description: "Live disengagement signals across your AM book. Snapshots refreshed hourly.",
    accent: "#C8431D", // Ember
    route: "/customer",
    kind: "internal",
  },
  {
    id: "performance",
    name: "Performance Beacon",
    description: "Per-customer growth and local-SEO reports. GBP, keywords, leads, reviews.",
    accent: "#D9A441", // Brass
    route: "/performance",
    kind: "internal",
  },
  {
    id: "escalation",
    name: "Escalation Beacon",
    description: "One search returns triage + Linear tickets + 5-channel comms timeline.",
    accent: "#7C2D12", // Deep Crimson
    route: "/escalation",
    kind: "internal",
  },
  {
    id: "post-payment",
    name: "Post-Payment Reviews",
    description: "Auto-gates new Discovery customers via Module 02 ICP at first pay.",
    accent: "#4A7C59", // Patina
    route: "/post-payment",
    kind: "internal",
  },
  {
    id: "miss-payment",
    name: "Miss Payment Beacon",
    description:
      "Live unpaid invoices across the book — ACH status, AM ownership, Linear tickets, per-row notes.",
    accent: "#2A4D5C", // Sea Lapis (Finance ops fits the lapis register)
    route: "/miss-payment",
    kind: "internal",
  },
  {
    id: "negative-keyword",
    name: "Negative Keyword Beacon",
    description:
      "AI-classified churn-risk signals across all 5 comms channels, with one-click Linear ticket creation.",
    accent: "#2D4843", // Pine — sentinel / watchtower register, distinct from Patina + Sea Lapis
    route: "/negative-keyword",
    kind: "internal",
  },
];
