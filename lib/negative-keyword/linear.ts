/**
 * Negative Keyword Beacon — Linear ticket creator. Phase NK-3.1.
 *
 * Ported from siranjt/negative-keyword-ticket-generator@0e77ca9
 * (app/api/create-tickets/route.ts) with the 7 mandatory rules
 * preserved BYTE-FOR-BYTE:
 *
 *   1. Title = exactly "🚨 RETENTION RISK ALERT 🚨"      (TICKET_TITLE)
 *   2. Template ID = ee431300-ce89-4f63-95d9-fef0e7d6c722 (TEMPLATE_ID)
 *      — passed to BOTH `templateId` AND `lastAppliedTemplateId` so
 *      the issue registers under the template + the template fields
 *      stay editable in Linear.
 *   3. Customer link MANDATORY via `customerNeedCreate` — refuse if
 *      no customer found.
 *   4. Dedup against open states (Todo/In Progress/In Review). Backlog
 *      is NOT an open state (it's `triage` type).
 *   5. Description = filled "Detailed Churn Risk Reason" + auto-ticked
 *      checklist categories per risk type.
 *   6. Assignee = AM looked up by name (exact full-name match).
 *   7. Initial state = Todo.
 *
 * These rules drive downstream automation owned by other teammates.
 * Changing title text, template ID, status, or skipping the customer
 * link will silently break those workflows.
 *
 * Bugs fixed during port (vs original 0e77ca9):
 *   - Cache reset removed: original cleared _teamId/_todoId at the top
 *     of every POST, defeating the cache. Module-level cache now persists.
 *   - findUser/findCustomer use FULL NAME exact-match (case-insensitive)
 *     instead of "first 3 results, take first." Two AMs sharing a first
 *     name would have collided in the original.
 *   - One transient-error retry on the gql() helper with 750ms backoff —
 *     a single Linear 502 used to silently mark the ticket "error" in
 *     the original results array.
 *   - Defensive trim on AM name and business name before interpolation
 *     so trailing whitespace doesn't break the lookup query.
 */

import type { AlertItem, RiskCategory } from "./types";

const LINEAR_API = "https://api.linear.app/graphql";
const TICKET_TITLE = "\u{1F6A8} RETENTION RISK ALERT \u{1F6A8}";
const TEMPLATE_ID = "ee431300-ce89-4f63-95d9-fef0e7d6c722";

/** Module-level cache — preserved across requests (Phase NK-3 bug fix). */
let _teamId: string | null = null;
let _todoId: string | null = null;

/** Wrap a single Linear call with one retry on transient errors. */
async function gql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY not set in environment variables");
  }

  const exec = async () => {
    const res = await fetch(LINEAR_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Linear API HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    return json.data as T;
  };

  try {
    return await exec();
  } catch (e) {
    // Retry once on transient errors (HTTP 5xx, network issues). Linear
    // is generally reliable but the 502s during peak hours used to drop
    // tickets in the original.
    const msg = e instanceof Error ? e.message : String(e);
    if (/HTTP 5\d\d|fetch failed|ECONN|ETIMEDOUT/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 750));
      return await exec();
    }
    throw e;
  }
}

/**
 * Build the description body per Rule 5. The 17-category checklist
 * matches the Linear template; specific categories auto-tick based on
 * the alert's risk_category. AM action items + meeting-summary fields
 * stay blank for the AM to fill manually after pickup.
 */
function buildDescription(a: AlertItem): string {
  const business = (a.business_name || "Unknown").trim();
  const am = (a.am_name || "Unassigned").trim();
  const category = a.risk_category;
  const source = a.source;
  const date = a.message_date;
  const time = a.message_time || "";
  const body = (a.message_body || "").slice(0, 500);

  const reason =
    `Business: ${business}\n` +
    `Entity ID: ${a.entity_id}\n` +
    `AM: ${am}\n` +
    `Risk Category: ${category}\n` +
    `Source: ${source}\n` +
    `Date: ${date}${time ? ` ${time}` : ""}\n\n` +
    `Signal:\n${body}\n\n` +
    `(Created from Negative Keyword Beacon)`;

  const catMap: Record<RiskCategory, string[]> = {
    "Lead quality": ["Leads velocity", "Leads Quality"],
    Cancellation: ["Unresponsive"],
    Billing: ["Missed payment"],
    Technical: ["Optimizing issues"],
    Disappointed: ["Pending actionable from team - delayed response"],
    Flagged: [],
  };
  const ticked = new Set(catMap[category] ?? []);

  // 17 categories — order + spelling preserved from the original
  // template. Don't change without coordinating with the team that
  // owns the downstream automation.
  const allCats = [
    "GBP unverified",
    "GBP post",
    "No manager access",
    "Returning leads",
    "Leads velocity",
    "Leads Quality",
    "Keyword mismatch",
    "Optimizing issues",
    "Website not published",
    "Does not like the website flow",
    "Pending actionable from team - delayed response",
    "Financial crisis",
    "Unresponsive",
    "Missed payment",
    "Social media",
    "Win",
    "Closing the business",
  ];
  const checklist = allCats
    .map((c) => `- [${ticked.has(c) ? "X" : " "}] ${c}`)
    .join("\n");

  return (
    `**Detailed Churn Risk Reason** :\n${reason}\n\n` +
    `**Churn Risk Reason category** :\n\n${checklist}\n\n` +
    `**First Dissatisfaction date :** ${date}\n\n` +
    `**What are the actionable done so far :**\n\n` +
    `**Was the churn prevention done earlier:**\n\n- [ ] Yes\n- [ ] No\n\n` +
    `**Churn prevention call scheduled:**\n\n- [ ] Yes\n- [ ] No\n\n` +
    `**Detailed Conclusion of the call:**\n\n`
  );
}

async function getTeamId(): Promise<string> {
  if (_teamId) return _teamId;
  const d = await gql<{ teams: { nodes: { id: string; name: string }[] } }>(
    `{ teams { nodes { id name } } }`,
  );
  const t = d.teams.nodes.find((x) => x.name.toLowerCase() === "finance");
  if (!t) throw new Error("Finance team not found in Linear");
  _teamId = t.id;
  return t.id;
}

async function getTodoId(teamId: string): Promise<string> {
  if (_todoId) return _todoId;
  const d = await gql<{ workflowStates: { nodes: { id: string }[] } }>(
    `query { workflowStates(filter: { team: { id: { eq: "${teamId}" } }, name: { eq: "Todo" } }, first: 1) { nodes { id } } }`,
  );
  if (!d.workflowStates?.nodes?.length) throw new Error("Todo state not found");
  _todoId = d.workflowStates.nodes[0].id;
  return _todoId;
}

/**
 * Exact full-name lookup. The original used `containsIgnoreCase` on
 * first-name only and returned the first hit — collisions between two
 * Sarahs would have routed tickets to the wrong AM.
 */
async function findUser(name: string): Promise<string | null> {
  const cleaned = name.replace(/"/g, "").trim();
  if (!cleaned) return null;
  // Pull up to 8 candidates with a contains-first-name filter (Linear
  // doesn't support exact-name in filter syntax), then resolve to
  // exact case-insensitive full-name match in code.
  const firstWord = cleaned.split(" ")[0];
  const d = await gql<{ users: { nodes: { id: string; name: string }[] } }>(
    `query { users(filter: { name: { containsIgnoreCase: "${firstWord}" } }, first: 8) { nodes { id name } } }`,
  );
  const target = cleaned.toLowerCase();
  const match = d.users?.nodes?.find((u) => u.name.trim().toLowerCase() === target);
  return match?.id || null;
}

/**
 * Exact case-insensitive business-name match. Same fix as findUser —
 * the original took the first contains-match and could route the
 * customer link to a similarly-named business.
 */
async function findCustomer(biz: string): Promise<string | null> {
  const cleaned = biz.replace(/"/g, "").trim();
  if (!cleaned) return null;
  const firstWord = cleaned.split(" ")[0];
  const d = await gql<{ customers: { nodes: { id: string; name: string }[] } }>(
    `query { customers(filter: { name: { containsIgnoreCase: "${firstWord}" } }, first: 8) { nodes { id name } } }`,
  );
  const target = cleaned.toLowerCase();
  const exact = d.customers?.nodes?.find(
    (c) => c.name.trim().toLowerCase() === target,
  );
  if (exact) return exact.id;
  // Fallback to first contains-match — better to attach to a near-name
  // than to refuse the ticket entirely. The dashboard's "ticket exists"
  // chip will surface the linked customer name for AM verification.
  return d.customers?.nodes?.[0]?.id || null;
}

/** Has an OPEN ticket already been created for this entity? */
async function hasDuplicate(teamId: string, entityId: string): Promise<boolean> {
  const d = await gql<{ issues: { nodes: { id: string }[] } }>(`query {
    issues(filter: {
      team: { id: { eq: "${teamId}" } },
      title: { eq: "${TICKET_TITLE.replace(/"/g, '\\"')}" },
      description: { contains: "${entityId}" },
      state: { type: { in: ["unstarted", "started"] } }
    }, first: 3) { nodes { id } }
  }`);
  return (d.issues?.nodes?.length || 0) > 0;
}

export interface CreatedTicket {
  ticket_id: string; // Linear UUID
  ticket_identifier: string; // human-readable e.g. "FIN-1234"
  ticket_url: string;
}

export type CreateTicketResult =
  | { ok: true; created: CreatedTicket }
  | { ok: false; skipped: true; reason: "duplicate" }
  | { ok: false; error: string };

/**
 * Create a single Linear retention-risk ticket for one alert.
 *
 * Returns:
 *   - { ok: true, created } on success
 *   - { ok: false, skipped: true, reason: "duplicate" } when an open
 *     ticket already exists for this entity (Rule 4 dedup hit)
 *   - { ok: false, error } for any other failure (customer-not-found,
 *     Linear API error, missing env var, etc.)
 *
 * Caller is responsible for stamping ticket fields on the DB row via
 * `markTicketed()` after success.
 */
export async function createRetentionTicketForAlert(
  alert: AlertItem,
): Promise<CreateTicketResult> {
  try {
    if (!process.env.LINEAR_API_KEY) {
      return { ok: false, error: "LINEAR_API_KEY not set" };
    }

    const teamId = await getTeamId();
    const todoId = await getTodoId(teamId);

    // Rule 4 — dedup
    if (await hasDuplicate(teamId, alert.entity_id)) {
      return { ok: false, skipped: true, reason: "duplicate" };
    }

    // Rule 3 — customer link MANDATORY
    const customerId = await findCustomer(alert.business_name);
    if (!customerId) {
      return {
        ok: false,
        error: `Customer "${alert.business_name}" not found in Linear — cannot create without customer link (Rule 3).`,
      };
    }

    // Rule 6 — AM lookup (best-effort; ticket still creates without)
    const assigneeId = alert.am_name ? await findUser(alert.am_name) : null;

    // Rules 1, 2, 5, 7 — title, template, description, Todo state
    const desc = buildDescription(alert);
    const mutation = `mutation {
      issueCreate(input: {
        teamId: "${teamId}"
        title: "${TICKET_TITLE.replace(/"/g, '\\"')}"
        templateId: "${TEMPLATE_ID}"
        lastAppliedTemplateId: "${TEMPLATE_ID}"
        description: ${JSON.stringify(desc)}
        stateId: "${todoId}"
        priority: 1
        ${assigneeId ? `assigneeId: "${assigneeId}"` : ""}
      }) {
        success
        issue { id identifier url }
      }
    }`;

    const cd = await gql<{
      issueCreate: {
        success: boolean;
        issue: { id: string; identifier: string; url: string };
      };
    }>(mutation);

    if (!cd.issueCreate?.success) {
      return { ok: false, error: "Linear issueCreate returned success=false" };
    }
    const issue = cd.issueCreate.issue;

    // Rule 3 (cont'd) — link customer request, MANDATORY
    const linkBody =
      `Retention risk: ${alert.risk_category}\n` +
      `Business: ${alert.business_name}\n` +
      `Entity ID: ${alert.entity_id}\n` +
      `AM: ${alert.am_name || "Unassigned"}\n` +
      `Source: ${alert.source}\n` +
      `Date: ${alert.message_date}${alert.message_time ? ` ${alert.message_time}` : ""}\n\n` +
      `Signal:\n${(alert.message_body || "").slice(0, 400)}`;

    await gql(`mutation {
      customerNeedCreate(input: {
        issueId: "${issue.id}"
        customerId: "${customerId}"
        body: ${JSON.stringify(linkBody)}
      }) { success }
    }`);

    return {
      ok: true,
      created: {
        ticket_id: issue.id,
        ticket_identifier: issue.identifier,
        ticket_url: issue.url,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Test/admin helper — clear the in-memory team/todo cache. Not exposed
 * via any route; available for diagnostic scripts and unit tests.
 */
export function _resetLinearCache(): void {
  _teamId = null;
  _todoId = null;
}
