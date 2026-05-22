/**
 * Phase 31.v2 — Unified ticket model (Metabase-sourced).
 *
 * v2 retires the HubSpot Service Hub + Linear GraphQL adapters that v1 used.
 * The dashboard now consumes a SINGLE Metabase public CSV that the Zoca team
 * maintains. There is no longer a per-vendor `source` discriminator; every
 * ticket originated from the same Metabase card.
 *
 * The CSV's WHERE clause already restricts to "active states + closed/canceled
 * in last 30 days", so we don't filter further here. We only transform.
 *
 * Pure module — no I/O. Safe to import from anywhere (client or server).
 */

export type TicketStatusCategory =
  | "triage"
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "closed_resolved"
  | "closed_unresolved"
  | "unknown";

export type UnifiedTicket = {
  /** Ticket id from CSV (Linear's id field — opaque string) */
  id: string;
  title: string;
  /** Normalized status enum derived from CSV `state_name` */
  status: TicketStatusCategory;
  /** Raw human-readable status from CSV `state_name` */
  status_label: string;
  /** CSV `ticket_category`; "Uncategorized" if blank */
  category: string;
  /** CSV `ticket_classification`; null if blank */
  classification: string | null;
  entity_id: string;
  bizname: string;
  am_name: string | null;
  ae_name: string | null;
  /** Display name; "Unassigned" when CSV is blank */
  assignee_name: string;
  assignee_email: string | null;
  creator_email: string | null;
  /** Chargebee customer_id, useful for cross-linking elsewhere in the app */
  customer_id: string | null;
  /** ISO of CSV `linear_created_at` (canonical "created at" despite the name) */
  created_at: string;
  /** ISO of CSV `last_updated_at`; drives "last touched Yd ago" UI */
  last_updated_at: string | null;
  /** ISO of CSV `completed_at` if closed-resolved */
  completed_at: string | null;
  /** ISO of CSV `canceled_at` if closed-unresolved */
  canceled_at: string | null;
  url: string;
  age_days: number;
  days_since_update: number | null;
  /** !is_closed && age_days >= TICKETS_STALE_DAYS */
  is_stale: boolean;
  is_closed: boolean;
};

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Map Linear's human-readable `state_name` to our normalized category.
 * Unknown states fall through to "unknown". Closed states are determined
 * here too — "Done" is closed_resolved, "Canceled" is closed_unresolved.
 */
export function categorizeStatus(stateName: string): TicketStatusCategory {
  const s = (stateName || "").trim().toLowerCase();
  switch (s) {
    case "triage":
      return "triage";
    case "backlog":
      return "backlog";
    case "todo":
    case "to do":
      return "todo";
    case "in progress":
      return "in_progress";
    case "in review":
      return "in_review";
    case "done":
    case "completed":
      return "closed_resolved";
    case "canceled":
    case "cancelled":
      return "closed_unresolved";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Color tokens — Tailwind class fragments for status chips.
// Open work uses sky/amber tints; closed work dims to emerald/zinc.
// No priority-based colors — the v2 CSV has no priority column.
// ---------------------------------------------------------------------------

export function statusColor(
  s: TicketStatusCategory,
): { bg: string; fg: string; label: string } {
  switch (s) {
    case "triage":
      return { bg: "bg-sky-500/18", fg: "text-sky-700", label: "Triage" };
    case "backlog":
      return { bg: "bg-sky-500/14", fg: "text-sky-700", label: "Backlog" };
    case "todo":
      return { bg: "bg-sky-500/18", fg: "text-sky-700", label: "Todo" };
    case "in_progress":
      return { bg: "bg-amber-500/18", fg: "text-amber-700", label: "In progress" };
    case "in_review":
      return { bg: "bg-amber-500/14", fg: "text-amber-700", label: "In review" };
    case "closed_resolved":
      return { bg: "bg-emerald-500/14", fg: "text-emerald-700", label: "Done" };
    case "closed_unresolved":
      return { bg: "bg-zoca-bg-tint", fg: "text-zoca-text-2", label: "Canceled" };
    case "unknown":
    default:
      return { bg: "bg-zoca-bg-tint", fg: "text-zoca-text-2", label: "Unknown" };
  }
}

// ---------------------------------------------------------------------------
// Sort + grouping helpers
// ---------------------------------------------------------------------------

/**
 * Sort tickets so the AM scans the most-actionable items first:
 *  - Open tickets before closed.
 *  - Within open: stale (is_stale=true) before fresh, then by age_days desc.
 *  - Within closed: most-recently-closed first (completed_at | canceled_at).
 */
export function sortTickets(tickets: UnifiedTicket[]): UnifiedTicket[] {
  const copy = tickets.slice();
  copy.sort((a, b) => {
    if (a.is_closed !== b.is_closed) return a.is_closed ? 1 : -1;
    if (!a.is_closed && !b.is_closed) {
      if (a.is_stale !== b.is_stale) return a.is_stale ? -1 : 1;
      return (b.age_days ?? 0) - (a.age_days ?? 0);
    }
    // both closed — recency desc
    const closedA = a.completed_at || a.canceled_at;
    const closedB = b.completed_at || b.canceled_at;
    const ca = closedA ? Date.parse(closedA) : 0;
    const cb = closedB ? Date.parse(closedB) : 0;
    return cb - ca;
  });
  return copy;
}

/**
 * Group tickets by category, preserving insertion order. "Uncategorized" is
 * always emitted last so AMs see meaningful buckets first.
 */
export function groupTicketsByCategory(
  tickets: UnifiedTicket[],
): Map<string, UnifiedTicket[]> {
  const groups = new Map<string, UnifiedTicket[]>();
  let uncategorized: UnifiedTicket[] | null = null;
  for (const t of tickets) {
    const key = t.category || "Uncategorized";
    if (key === "Uncategorized") {
      if (!uncategorized) uncategorized = [];
      uncategorized.push(t);
      continue;
    }
    const arr = groups.get(key);
    if (arr) arr.push(t);
    else groups.set(key, [t]);
  }
  if (uncategorized && uncategorized.length) {
    groups.set("Uncategorized", uncategorized);
  }
  return groups;
}
