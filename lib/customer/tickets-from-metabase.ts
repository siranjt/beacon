/**
 * Phase 31.v2 — Tickets enrichment from Metabase.
 *
 * Single CSV fetch per nightly refresh, replacing the v1 HubSpot Service Hub
 * + Linear GraphQL adapters. The CSV is maintained by the Zoca team and
 * already filters to "active states + closed/canceled in last 30 days".
 *
 * Soft-fails on any error — never throws to refresh.ts. We'd rather ship
 * a snapshot with empty tickets than break the entire pipeline.
 */

import Papa from "papaparse";
import { METABASE_ENDPOINTS, TICKETS_STALE_DAYS } from "./config";
import {
  categorizeStatus,
  sortTickets,
  type UnifiedTicket,
} from "./tickets-unified";

// Local copies of the helpers from lib/metabase.ts. Kept inline here so this
// module is self-contained and doesn't depend on metabase.ts re-exporting them
// (lib/metabase.ts keeps them private — see Phase 31.v1 RFC).
async function fetchCsvText(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    cache: "no-store",
    headers: { Accept: "text/csv" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Metabase CSV ${url} ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.text();
}

function parseRows<T extends Record<string, string>>(csv: string): T[] {
  const out = Papa.parse<T>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  return (out.data || []).filter((r) => r && typeof r === "object");
}

function parseIso(s: string | undefined | null): string | null {
  if (!s) return null;
  const clean = s.trim();
  if (!clean) return null;
  // Metabase exports timestamps as e.g. "2026-05-09 14:32:00" (UTC). Append Z
  // for unambiguous parsing.
  const candidate = clean.endsWith("Z") || clean.includes("+")
    ? clean
    : clean.replace(" ", "T") + "Z";
  const t = Date.parse(candidate);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

function daysBetween(fromIso: string | null, toMs: number): number | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((toMs - t) / 86_400_000));
}

export type TicketsFetchResult = {
  byEntityId: Map<string, UnifiedTicket[]>;
  totalRows: number;
  parseErrors: number;
};

export async function fetchTicketsFromMetabase(): Promise<TicketsFetchResult> {
  const empty: TicketsFetchResult = {
    byEntityId: new Map(),
    totalRows: 0,
    parseErrors: 0,
  };

  try {
    const csv = await fetchCsvText(METABASE_ENDPOINTS.tickets);
    const raw = parseRows<Record<string, string>>(csv);
    const now = Date.now();

    const byEntityId = new Map<string, UnifiedTicket[]>();
    let parseErrors = 0;

    for (const r of raw) {
      const id = (r["id"] || "").trim();
      const entityId = (r["entity_id"] || "").trim();

      // Skip rows missing the join key or row identity. These are unrecoverable
      // — there's no way to attach them to a customer.
      if (!id || !entityId) {
        parseErrors += 1;
        continue;
      }

      const createdAt = parseIso(r["linear_created_at"]);
      if (!createdAt) {
        parseErrors += 1;
        continue;
      }

      const lastUpdatedAt = parseIso(r["last_updated_at"]);
      const completedAt = parseIso(r["completed_at"]);
      const canceledAt = parseIso(r["canceled_at"]);
      const stateName = (r["state_name"] || "").trim();

      const isClosed = !!completedAt || !!canceledAt;
      const ageDays = daysBetween(createdAt, now) ?? 0;
      const daysSinceUpdate = daysBetween(lastUpdatedAt, now);
      const isStale = !isClosed && ageDays >= TICKETS_STALE_DAYS;

      const assigneeRaw = (r["assignee_name"] || "").trim();
      const categoryRaw = (r["ticket_category"] || "").trim();
      const classificationRaw = (r["ticket_classification"] || "").trim();

      const ticket: UnifiedTicket = {
        id,
        title: (r["title"] || "").trim() || "(untitled ticket)",
        status: categorizeStatus(stateName),
        status_label: stateName || "Unknown",
        category: categoryRaw || "Uncategorized",
        classification: classificationRaw || null,
        entity_id: entityId,
        bizname: (r["customer_name"] || "").trim(),
        am_name: (r["am_name"] || "").trim() || null,
        ae_name: (r["ae_name"] || "").trim() || null,
        assignee_name: assigneeRaw || "Unassigned",
        assignee_email: (r["assignee_email"] || "").trim() || null,
        creator_email: (r["creator_email"] || "").trim() || null,
        customer_id: (r["customer_id"] || "").trim() || null,
        created_at: createdAt,
        last_updated_at: lastUpdatedAt,
        completed_at: completedAt,
        canceled_at: canceledAt,
        url: (r["linear_url"] || "").trim(),
        age_days: ageDays,
        days_since_update: daysSinceUpdate,
        is_stale: isStale,
        is_closed: isClosed,
      };

      const arr = byEntityId.get(entityId);
      if (arr) arr.push(ticket);
      else byEntityId.set(entityId, [ticket]);
    }

    // Sort each entity's bucket so renderers can take a top-N slice without
    // re-sorting.
    for (const [eid, arr] of byEntityId) {
      byEntityId.set(eid, sortTickets(arr));
    }

    return {
      byEntityId,
      totalRows: raw.length,
      parseErrors,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[tickets-from-metabase] fetch failed, returning empty:", msg);
    return empty;
  }
}
