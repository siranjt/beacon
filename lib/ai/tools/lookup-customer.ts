/**
 * lookup_customer — Beacon AI tool. Phase E-16 Wave 2.
 *
 * Read-only fuzzy customer search. Scans the latest dashboard_snapshots_v2 row
 * and matches a plain-English query against bizname (substring, lowercase),
 * entity_id prefix, and Chargebee customer handle (customer_id). Returns the
 * top 5 candidates with enough fields for Claude to chain a follow-up tool
 * call (snooze / pin / mark-contacted / add-note / draft email / draft slack).
 *
 * No blast radius — does NOT mutate state, does NOT require approval. The
 * executor endpoint still rate-limits (20/hour) and audit-logs every call so
 * we can see how often the model reaches for this tool.
 *
 * v1 ranking:
 *   1. exact lowercase match on bizname  (score 1000)
 *   2. lowercase substring on bizname    (score: 600 + match-length bonus)
 *   3. entity_id prefix match (>=4 chars) (score 400)
 *   4. customer_id exact match            (score 800)
 *   5. customer_id substring              (score 300)
 *
 * Ties broken by composite desc so the at-risk customer wins when names
 * overlap (more relevant for a triage tool).
 */

import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const MAX_RESULTS = 5;
const MAX_QUERY_LEN = 200;

interface LookupHit {
  entity_id: string;
  bizname: string | null;
  am_name: string | null;
  stoplight: "RED" | "YELLOW" | "GREEN" | null;
  composite_score: number | null;
  tier: string | null;
  customer_id: string | null;
  last_contact_date: string | null;
  city: string | null;
  match_score: number;
}

function rank(query: string, c: ScoredCustomerV2): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const biz = (c.company ?? "").toLowerCase();
  const eid = (c.entity_id ?? "").toLowerCase();
  const cb = (c.customer_id ?? "").toLowerCase();

  let score = 0;
  if (biz && biz === q) score = Math.max(score, 1000);
  else if (biz && biz.includes(q)) {
    // Substring match: longer relative coverage scores higher.
    const ratio = q.length / Math.max(biz.length, 1);
    score = Math.max(score, 600 + Math.round(ratio * 100));
  }
  if (cb && cb === q) score = Math.max(score, 800);
  else if (cb && cb.includes(q)) score = Math.max(score, 300);

  if (q.length >= 4 && eid.startsWith(q)) score = Math.max(score, 400);

  return score;
}

export const lookupCustomerTool: BeaconTool = {
  name: "lookup_customer",
  description:
    "Fuzzy search for a customer by bizname, entity_id prefix, or Chargebee handle when they're not already in CONTEXT. Returns up to 5 matches (entity_id, bizname, AM, stoplight, composite, tier, last contact) so you can chain a follow-up action tool. Read-only. If the customer is already listed in CONTEXT, use that instead.\n" +
    "Trigger phrases: \"look up Acme Salon\", \"find skin and tonic\", \"who's the AM on Maven & Co\".",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Plain-English search query. Examples: 'Acme Salon in Pune', 'skin and tonic', 'RED customer with billing dispute that Sudha manages'. We match against bizname (substring), entity_id (prefix), and Chargebee customer_id. Keep it short — the noisier the query, the worse the match.",
        minLength: 2,
        maxLength: MAX_QUERY_LEN,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const raw = typeof args.query === "string" ? args.query.trim() : "";
    if (!raw) return { ok: false, error: "query must be a non-empty string" };
    if (raw.length > MAX_QUERY_LEN) {
      return { ok: false, error: `query too long (max ${MAX_QUERY_LEN})` };
    }

    try {
      const snap = await readLatestSnapshotV2();
      const all = snap?.customers ?? [];

      const scored: Array<{ c: ScoredCustomerV2; score: number }> = [];
      for (const c of all) {
        const s = rank(raw, c);
        if (s > 0) scored.push({ c, score: s });
      }

      // Stable sort: primary by match score desc, tiebreak by composite desc
      // so triage-relevant customers float to the top when names collide.
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ca = a.c.signals_v2?.composite ?? 0;
        const cb = b.c.signals_v2?.composite ?? 0;
        return cb - ca;
      });

      const top = scored.slice(0, MAX_RESULTS).map<LookupHit>(({ c, score }) => ({
        entity_id: c.entity_id,
        bizname: c.company ?? null,
        am_name: c.am_name ?? null,
        stoplight: (c.signals_v2?.stoplight ?? null) as LookupHit["stoplight"],
        composite_score: c.signals_v2?.composite ?? null,
        tier: c.signals_v2?.tier ?? null,
        customer_id: c.customer_id ?? null,
        last_contact_date: c.metrics?.last_out_iso ?? c.metrics?.last_any_iso ?? null,
        city: null,
        match_score: score,
      }));

      const summary =
        top.length === 0
          ? `No customers matched "${raw}".`
          : `Found ${top.length} match${top.length === 1 ? "" : "es"} for "${raw}" — top: ${top[0].bizname ?? top[0].entity_id}.`;

      // Read-only audit row so we can see how often lookup gets called and
      // by whom. entity_id is set to the top hit when we found one — that
      // gives the per-customer activity timeline a single anchor row.
      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:lookup_customer",
        surface: "customer-360",
        entity_id: top[0]?.entity_id ?? null,
        metadata: {
          source: "beacon_ai",
          tool: "lookup_customer",
          query: raw,
          result_count: top.length,
          top_hits: top.map((t) => ({
            entity_id: t.entity_id,
            bizname: t.bizname,
            match_score: t.match_score,
          })),
        },
      });

      return {
        ok: true,
        summary,
        data: { query: raw, results: top },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:lookup_customer:error",
        surface: "customer-360",
        entity_id: null,
        metadata: { source: "beacon_ai", error: msg, query: raw },
      });
      return { ok: false, error: msg };
    }
  },
};
