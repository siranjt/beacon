// Tickets — sourced from a Metabase public CSV that pre-joins Linear tickets
// to Zoca entities. Replaces the earlier Linear-API path.
//
// Public CSV: https://metabase.zoca.ai/public/question/331e4835-…csv
// Schema (verified by sampling real rows):
//   id, linear_created_at, month_number, year, title, description, linear_url,
//   state_name, started_at, canceled_at, completed_at, entity_id, customer_name,
//   creator_email, assignee_email, ticket_category, ticket_classification,
//   customer_id, churn_potential_status, am_name, ae_name
//
// ticket_classification distinct values:
//   Churn Ticket | Retention Risk Alert | Subscription Support Ticket
//   | paid_user_offboarding | Subscription_Cancellation
//
// At ~2 MB / ~1.7K rows the whole CSV fits comfortably in memory; we buffer
// it once and cache for 1 hour at the Vercel edge, then filter in memory.

import { parseCsv } from "./metabase";

const TICKETS_CSV_URL =
  "https://metabase.zoca.ai/public/question/331e4835-e163-4981-877e-14592f71741d.csv";

export type TicketClassification =
  | "Churn Ticket"
  | "Retention Risk Alert"
  | "Subscription Support Ticket"
  | "paid_user_offboarding"
  | "Subscription_Cancellation";

export const ALL_CLASSIFICATIONS: TicketClassification[] = [
  "Churn Ticket",
  "Retention Risk Alert",
  "Subscription Support Ticket",
  "paid_user_offboarding",
  "Subscription_Cancellation",
];

export interface MetabaseTicket {
  id: string;
  identifier: string; // "FIN-1317", "CX-1787" — parsed from linear_url
  title: string;
  description: string;
  url: string; // linear_url
  state: string; // Done | Todo | In Progress | In Review | Canceled | Duplicate
  classification: string; // ticket_classification
  category: string; // ticket_category — assigned_to_am | assigned_by_am | other_team
  churnPotentialStatus: string;
  createdAt: string; // ISO
  startedAt: string;
  completedAt: string;
  cancelledAt: string;
  entityId: string;
  customerName: string;
  customerId: string;
  amName: string;
  aeName: string;
  creatorEmail: string;
  assigneeEmail: string;
}

let memoryCache: { tickets: MetabaseTicket[]; loadedAt: number } | null = null;
const MEMORY_TTL_MS = 5 * 60 * 1000; // 5 min in-process cache (per Vercel instance)

function parseIdentifier(linearUrl: string): string {
  // Format: https://linear.app/zoca/issue/FIN-1317/...
  const m = linearUrl.match(/\/issue\/([A-Z]+-\d+)/i);
  return m ? m[1].toUpperCase() : "";
}

function isoOrEmpty(s: string | undefined): string {
  if (!s) return "";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return "";
  return new Date(t).toISOString();
}

function rowToTicket(r: Record<string, string>): MetabaseTicket {
  return {
    id: r["id"] || "",
    identifier: parseIdentifier(r["linear_url"] || ""),
    title: r["title"] || "",
    description: r["description"] || "",
    url: r["linear_url"] || "",
    state: r["state_name"] || "",
    classification: r["ticket_classification"] || "",
    category: r["ticket_category"] || "",
    churnPotentialStatus: r["churn_potential_status"] || "",
    createdAt: isoOrEmpty(r["linear_created_at"]),
    startedAt: isoOrEmpty(r["started_at"]),
    completedAt: isoOrEmpty(r["completed_at"]),
    cancelledAt: isoOrEmpty(r["canceled_at"]),
    entityId: (r["entity_id"] || "").trim(),
    customerName: r["customer_name"] || "",
    customerId: r["customer_id"] || "",
    amName: r["am_name"] || "",
    aeName: r["ae_name"] || "",
    creatorEmail: r["creator_email"] || "",
    assigneeEmail: r["assignee_email"] || "",
  };
}

/** Pull every ticket. Buffered + cached. */
export async function fetchAllTickets(): Promise<MetabaseTicket[]> {
  if (memoryCache && Date.now() - memoryCache.loadedAt < MEMORY_TTL_MS) {
    return memoryCache.tickets;
  }
  const res = await fetch(TICKETS_CSV_URL, {
    headers: { Accept: "text/csv" },
    // Vercel edge cache for 1 hour. Combined with memoryCache above this means
    // a busy instance will rarely re-download the CSV.
    next: { revalidate: 3600 },
  });
  if (!res.ok) {
    throw new Error(`Tickets CSV fetch failed: ${res.status}`);
  }
  const text = await res.text();
  const rows = parseCsv(text);
  const tickets = rows.map(rowToTicket);
  memoryCache = { tickets, loadedAt: Date.now() };
  return tickets;
}

export interface TicketFilter {
  entityId?: string;
  customerId?: string;
  bizName?: string; // substring match on customer_name (case-insensitive)
  classifications?: TicketClassification[];
  states?: string[];
  sinceDays?: number; // filters by createdAt
  limit?: number;
}

function passes(t: MetabaseTicket, f: TicketFilter): boolean {
  if (f.entityId && t.entityId.toLowerCase() !== f.entityId.toLowerCase()) {
    if (!f.bizName && !f.customerId) return false;
    // Allow OR with bizName / customerId below — check those
  }
  // We OR the customer-link clauses (entityId | customerId | bizName)
  // because the user might pass any combination.
  const customerLinks: boolean[] = [];
  if (f.entityId) customerLinks.push(t.entityId.toLowerCase() === f.entityId.toLowerCase());
  if (f.customerId) customerLinks.push(t.customerId === f.customerId);
  if (f.bizName) {
    const q = f.bizName.toLowerCase();
    customerLinks.push(t.customerName.toLowerCase().includes(q));
  }
  if (customerLinks.length && !customerLinks.some(Boolean)) return false;

  if (f.classifications && f.classifications.length) {
    if (!f.classifications.includes(t.classification as TicketClassification)) return false;
  }
  if (f.states && f.states.length) {
    if (!f.states.includes(t.state)) return false;
  }
  if (f.sinceDays && f.sinceDays > 0) {
    const cutoff = Date.now() - f.sinceDays * 24 * 3600 * 1000;
    const created = Date.parse(t.createdAt);
    if (Number.isNaN(created) || created < cutoff) return false;
  }
  return true;
}

/** Tickets matching ANY of entityId / customerId / bizName, plus optional state/classification filters. */
export async function fetchTicketsForCustomer(filter: TicketFilter): Promise<MetabaseTicket[]> {
  if (!filter.entityId && !filter.customerId && (!filter.bizName || filter.bizName.trim().length < 3)) {
    return [];
  }
  const all = await fetchAllTickets();
  const matches = all.filter((t) => passes(t, filter));
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // latest first
  const limit = filter.limit ?? 100;
  return matches.slice(0, limit);
}

/** Used by the standalone /tickets page — no customer filter, just classification/state/time. */
export async function fetchTickets(filter: Omit<TicketFilter, "entityId" | "customerId" | "bizName">): Promise<MetabaseTicket[]> {
  const all = await fetchAllTickets();
  const matches = all.filter((t) => {
    if (filter.classifications && filter.classifications.length) {
      if (!filter.classifications.includes(t.classification as TicketClassification)) return false;
    }
    if (filter.states && filter.states.length) {
      if (!filter.states.includes(t.state)) return false;
    }
    if (filter.sinceDays && filter.sinceDays > 0) {
      const cutoff = Date.now() - filter.sinceDays * 24 * 3600 * 1000;
      const created = Date.parse(t.createdAt);
      if (Number.isNaN(created) || created < cutoff) return false;
    }
    return true;
  });
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const limit = filter.limit ?? 200;
  return matches.slice(0, limit);
}
