/**
 * Negative Keyword Beacon — open Linear tickets reader. Phase NK-3.2.
 *
 * Ported from siranjt/negative-keyword-ticket-generator@0e77ca9
 * (app/api/tickets-created/route.ts). Returns retention-risk tickets in
 * open states only (Todo / In Progress / In Review).
 *
 * Pinned Finance team ID — same constant as linear.ts uses indirectly
 * via the Finance-team-name lookup. Hardcoded here for read speed:
 *   - Avoids a teams() query on every dashboard load.
 *   - The team ID never rotates (it's a Linear UUID set at team
 *     creation time).
 *
 * Linear field name `formerNeeds` is used instead of `customerNeeds` —
 * Linear renamed the field; the original codebase already had this
 * fix (see commit 0e77ca9 "Fix: use formerNeeds instead of customerNeeds
 * in Linear GraphQL").
 */

const LINEAR_API = "https://api.linear.app/graphql";
const FINANCE_TEAM_ID = "10848e63-4beb-4096-a505-a2f928e95eb9";
const OPEN_STATE_NAMES = new Set(["Todo", "In Progress", "In Review"]);

/** Shape consumed by the Created Tickets dashboard tab. */
export interface OpenRetentionTicket {
  ticket_id: string; // identifier like "FIN-1234"
  url: string;
  business: string;
  am: string;
  category: string; // RiskCategory or "—"
  alert_date: string; // YYYY-MM-DD or "—"
  status: string; // workflow state name
  status_type: string; // workflow state type (unstarted/started/...)
  created_at: string; // ISO
}

/**
 * List open retention-risk tickets from Linear.
 *
 * Returns an empty list (NOT an error) when LINEAR_API_KEY is unset —
 * keeps the dashboard's Tickets tab functional in dev environments
 * without Linear credentials.
 */
export async function listOpenRetentionTickets(): Promise<OpenRetentionTicket[]> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return [];

  const query = `{
    issues(
      filter: { team: { id: { eq: "${FINANCE_TEAM_ID}" } } }
      orderBy: createdAt
      first: 250
    ) {
      nodes {
        identifier
        title
        url
        description
        createdAt
        assignee { name }
        state { name type }
        needs: formerNeeds { nodes { customer { name } } }
      }
    }
  }`;

  let res: Response;
  try {
    res = await fetch(LINEAR_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });
  } catch (e) {
    console.warn(
      `[nk/tickets-read] fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(
      `[nk/tickets-read] Linear HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
    return [];
  }

  let json: {
    data?: {
      issues?: {
        nodes?: Array<{
          identifier: string;
          title: string;
          url: string;
          description: string | null;
          createdAt: string;
          assignee: { name: string } | null;
          state: { name: string; type: string } | null;
          needs: { nodes: { customer: { name: string } }[] } | null;
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  try {
    json = await res.json();
  } catch (e) {
    console.warn(
      `[nk/tickets-read] JSON parse: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }

  if (json.errors?.length) {
    console.warn(`[nk/tickets-read] Linear error: ${json.errors[0].message}`);
    return [];
  }

  const issues = json.data?.issues?.nodes ?? [];

  return issues
    .filter(
      (t) =>
        !!t.title &&
        t.title.includes("RETENTION RISK ALERT") &&
        !!t.state &&
        OPEN_STATE_NAMES.has(t.state.name),
    )
    .map((t) => {
      const desc = t.description || "";
      const bizMatch = desc.match(/Business:\s*(.+)/);
      const business =
        bizMatch?.[1]?.trim() ||
        t.needs?.nodes?.[0]?.customer?.name?.split(" | ")?.[0] ||
        "Unknown";
      const catMatch = desc.match(/Risk Category:\s*(.+)/);
      const category = catMatch?.[1]?.trim() || "—";
      const dateMatch = desc.match(/Date:\s*(\S+)/);
      const alertDate = dateMatch?.[1]?.trim() || "—";

      return {
        ticket_id: t.identifier,
        url: t.url,
        business,
        am: t.assignee?.name || "Unassigned",
        category,
        alert_date: alertDate,
        status: t.state?.name || "Unknown",
        status_type: t.state?.type || "unstarted",
        created_at: t.createdAt,
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
