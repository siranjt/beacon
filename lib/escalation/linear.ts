// Linear GraphQL client.
//
// Tickets we care about live in two Linear teams:
//   - Finance team           -> Churn🚨, 🚨 RETENTION RISK ALERT 🚨, SUBSCIPTION_SUPPORT |…
//   - Customer Success (CX)  -> PAID_USER_OFFBOARDING | …
//
// Title patterns (verified against real tickets):
//   churn                  -> "Churn🚨"
//   retention_risk         -> "🚨 RETENTION RISK ALERT 🚨"
//   subscription_support   -> "SUBSCIPTION_SUPPORT |…" (note: misspelled "SUBSCIPTION")
//   paid_offboarding       -> "PAID_USER_OFFBOARDING |…" (CX team)
//
// SUBSCIPTION_SUPPORT and PAID_USER_OFFBOARDING tickets embed `entityId: <uuid>`
// in the description, which lets us join Zoca customers to their tickets exactly.

const LINEAR_API_URL = "https://api.linear.app/graphql";

const TEAM_IDS = {
  finance: "10848e63-4beb-4096-a505-a2f928e95eb9",
  cx: "cb62c09f-9a4c-42da-b4fb-5479f7af22e5",
};

export type TitlePattern =
  | "churn"
  | "retention_risk"
  | "subscription_support"
  | "paid_offboarding";

const PATTERN_TO_TERMS: Record<TitlePattern, string[]> = {
  churn: ["churn"],
  retention_risk: ["retention risk"],
  // Match BOTH the canonical spelling and the misspelling we saw in real titles.
  subscription_support: ["subscription support", "subsciption_support"],
  paid_offboarding: ["paid_user_offboarding", "offboarding"],
};

export interface LinearTicket {
  id: string;
  identifier: string; // e.g. "FIN-3901" or "CX-1787"
  title: string;
  description: string | null;
  priority: number;
  priorityLabel: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  startedAt: string | null;
  state: { name: string; type: string };
  team: { id: string; name: string; key: string };
  assignee: { name: string; email: string } | null;
  creator: { name: string } | null;
  labels: string[];
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function gql<T>(query: string, variables?: any): Promise<T> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error("LINEAR_API_KEY is not set");

  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
    next: { revalidate: 60 },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as GraphqlResponse<T>;
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error("Linear: empty response");
  return json.data;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  priorityLabel
  url
  createdAt
  updatedAt
  completedAt
  cancelledAt
  startedAt
  state { name type }
  team { id name key }
  assignee { name email }
  creator { name }
  labels { nodes { name } }
`;

interface IssuesResponse {
  issues: {
    nodes: any[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

function mapIssue(n: any): LinearTicket {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description,
    priority: n.priority,
    priorityLabel: n.priorityLabel,
    url: n.url,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    completedAt: n.completedAt,
    cancelledAt: n.cancelledAt,
    startedAt: n.startedAt,
    state: { name: n.state?.name || "", type: n.state?.type || "" },
    team: { id: n.team?.id || "", name: n.team?.name || "", key: n.team?.key || "" },
    assignee: n.assignee ? { name: n.assignee.name, email: n.assignee.email } : null,
    creator: n.creator ? { name: n.creator.name } : null,
    labels: (n.labels?.nodes || []).map((l: any) => l.name),
  };
}

// Build the title-pattern OR clauses for a given list of patterns.
function titleClausesFor(patterns: TitlePattern[]): any[] {
  return patterns.flatMap((p) =>
    PATTERN_TO_TERMS[p].map((term) => ({ title: { containsIgnoreCase: term } }))
  );
}

// Team-membership clause: either Finance or CX.
const TEAM_OR_CLAUSE: any = {
  or: [
    { team: { id: { eq: TEAM_IDS.finance } } },
    { team: { id: { eq: TEAM_IDS.cx } } },
  ],
};

/**
 * Pull the most recent escalation tickets across Finance + CX teams matching
 * the requested title patterns. Used by the standalone /tickets page.
 */
export async function fetchEscalationTickets(opts?: {
  patterns?: TitlePattern[];
  limit?: number;
  sinceDays?: number;
}): Promise<LinearTicket[]> {
  const patterns =
    opts?.patterns && opts.patterns.length
      ? opts.patterns
      : (["churn", "retention_risk", "subscription_support", "paid_offboarding"] as TitlePattern[]);
  const limit = Math.min(opts?.limit ?? 100, 250);
  const sinceDays = opts?.sinceDays ?? 0;

  const filter: any = {
    and: [TEAM_OR_CLAUSE, { or: titleClausesFor(patterns) }],
  };
  if (sinceDays > 0) {
    const cutoff = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();
    filter.and.push({ updatedAt: { gte: cutoff } });
  }

  const query = `
    query EscalationTickets($filter: IssueFilter!, $first: Int!) {
      issues(filter: $filter, first: $first, orderBy: updatedAt) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const data = await gql<IssuesResponse>(query, { filter, first: limit });
  const tickets = (data.issues.nodes || []).map(mapIssue);
  tickets.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return tickets;
}

/**
 * Tickets specifically tied to one customer. Matches in priority order:
 *   1. description contains the entity_id   (exact — the most reliable join)
 *   2. title contains the business name     (fuzzy — useful for retention tickets)
 */
export async function fetchTicketsForEntity(opts: {
  entityId?: string;
  bizName?: string;
  patterns?: TitlePattern[];
  sinceDays?: number;
  limit?: number;
}): Promise<LinearTicket[]> {
  const { entityId, bizName } = opts;
  if (!entityId && !bizName) return [];

  const patterns =
    opts.patterns && opts.patterns.length
      ? opts.patterns
      : (["churn", "retention_risk", "subscription_support", "paid_offboarding"] as TitlePattern[]);
  const limit = Math.min(opts.limit ?? 50, 250);
  const sinceDays = opts.sinceDays ?? 0;

  // Customer-link clauses: entity match OR biz-name title match.
  const customerOr: any[] = [];
  if (entityId) customerOr.push({ description: { containsIgnoreCase: entityId } });
  if (bizName && bizName.trim().length >= 3) {
    customerOr.push({ title: { containsIgnoreCase: bizName.trim() } });
  }
  if (!customerOr.length) return [];

  const filter: any = {
    and: [TEAM_OR_CLAUSE, { or: titleClausesFor(patterns) }, { or: customerOr }],
  };
  if (sinceDays > 0) {
    const cutoff = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();
    filter.and.push({ updatedAt: { gte: cutoff } });
  }

  const query = `
    query TicketsForEntity($filter: IssueFilter!, $first: Int!) {
      issues(filter: $filter, first: $first, orderBy: updatedAt) {
        nodes { ${ISSUE_FIELDS} }
      }
    }
  `;

  const data = await gql<IssuesResponse>(query, { filter, first: limit });
  const tickets = (data.issues.nodes || []).map(mapIssue);
  tickets.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return tickets;
}

/** Used for badges on the standalone tickets page. */
export function classifyPattern(title: string): TitlePattern[] {
  const t = (title || "").toLowerCase();
  const hits: TitlePattern[] = [];
  for (const p of Object.keys(PATTERN_TO_TERMS) as TitlePattern[]) {
    for (const term of PATTERN_TO_TERMS[p]) {
      if (t.includes(term.toLowerCase())) {
        hits.push(p);
        break;
      }
    }
  }
  return hits;
}

// Keep the old name alive so existing callers still compile.
export const fetchFinanceTickets = fetchEscalationTickets;
