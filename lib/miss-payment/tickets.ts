/**
 * Miss Payment Beacon — Active Linear tickets join.
 *
 * Pulls active Finance tickets (Todo / In Progress / In Review) from a
 * Metabase public CSV and joins them onto the missed-invoice rows by
 * `entity_id`. The most-recent active ticket per entity surfaces as
 * the "Tickets" column on the dashboard.
 *
 * Write-off / refund titles are filtered out — those describe accounting
 * actions, not customer issues an AM needs to chase.
 *
 * 5-min in-memory cache (matches invoices cache TTL).
 */

import "server-only";
import Papa from "papaparse";

const METABASE_TICKETS_URL =
  process.env.METABASE_TICKETS_URL ||
  "https://metabase.zoca.ai/public/question/331e4835-e163-4981-877e-14592f71741d.csv";

const TIMEOUT_MS = Number(process.env.METABASE_TICKETS_TIMEOUT_MS || 15_000);

/** Linear state_name values that count as "active". */
const ACTIVE_STATES = new Set(["Todo", "In Progress", "In Review"]);

/** Title prefixes we never surface — accounting actions, not customer issues. */
const EXCLUDED_TITLE_PREFIXES = ["write off", "write-off", "writeoff", "refund"];

export type Ticket = {
  /** Linear identifier extracted from the URL — e.g. "FIN-3153". */
  identifier: string;
  title: string;
  url: string;
  /** Lowercased Zoca entity_id used as the join key. */
  entityId: string;
  state: string;
  createdAt: string;
};

const ID_REGEX = /linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/i;

let cache: { rows: Ticket[]; ts: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchActiveTickets(): Promise<Ticket[]> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.rows;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let csv: string;
  try {
    const r = await fetch(METABASE_TICKETS_URL, {
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "follow",
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Metabase tickets ${r.status}: ${text.slice(0, 200)}`);
    }
    csv = await r.text();
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(`Metabase tickets timeout after ${TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }

  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });

  const out: Ticket[] = [];
  for (const row of parsed.data) {
    const state = (row.state_name || "").trim();
    if (!ACTIVE_STATES.has(state)) continue;

    const title = (row.title || "").trim();
    const titleLc = title.toLowerCase();
    if (EXCLUDED_TITLE_PREFIXES.some((p) => titleLc.startsWith(p))) continue;

    const entityId = (row.entity_id || "").trim().toLowerCase();
    if (!entityId) continue;

    const url = (row.linear_url || "").trim();
    if (!url) continue;

    const m = url.match(ID_REGEX);
    const identifier = m ? m[1] : "";

    out.push({
      identifier,
      title,
      url,
      entityId,
      state,
      createdAt: (row.linear_created_at || "").trim(),
    });
  }

  cache = { rows: out, ts: now };
  return out;
}

/** Build Map<entity_id, Ticket> picking the most-recently-created
 *  active ticket per entity. Ascending sort + last-write semantics
 *  on the Map gives us "newest wins". */
export function indexTicketsByEntity(tickets: Ticket[]): Map<string, Ticket> {
  const out = new Map<string, Ticket>();
  const sorted = [...tickets].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  for (const t of sorted) out.set(t.entityId, t);
  return out;
}
