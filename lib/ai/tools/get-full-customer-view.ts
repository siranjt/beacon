/**
 * get_full_customer_view — Beam tool. Cross-scope synthesis.
 *
 * Bundles every per-customer Beam can already read individually — Keeper
 * facts, comms perspective, performance summary, open escalations, notes
 * summary — into a single tool call so the AM gets a holistic answer
 * without Beam chaining 4-5 sequential read_* calls. Same shape pattern
 * as the other read tools (read_customer_brain etc.) so the registry +
 * action card + executor can run it unchanged.
 *
 * Input:
 *   - entity_id (required)
 *   - question (optional) — when present, Keeper retrieval routes through
 *     retrieveFactsHybrid for the top-10 most relevant facts instead of
 *     the dump-all topic-clustered block. Mirrors read_customer_brain's
 *     two-mode behavior so a tightly-scoped question gets a tight answer.
 *
 * Output sections — every one is independently nullable. The model can
 * tell from a `null` section that the sub-load soft-failed or returned
 * nothing, and reason accordingly.
 *   - identity        — entity_id + bizname + am_name + cb_customer_id
 *   - keeper          — facts (mode: hybrid or topic_block)
 *   - comms_perspective — last cached Haiku read (90-day window)
 *   - performance_summary — leads YTD, GBP click trend, top keyword counts
 *   - escalations     — open Linear tickets + recent activity
 *   - notes_summary   — count + last-edited + role-scoped preview
 *   - meta            — { loaded: [], failed: [], timing_ms_by_section }
 *
 * Design choices:
 *   - Promise.allSettled fan-out, NOT loadCustomer360Context. The 360
 *     loader bundles MORE than this tool needs (post-payment row, JSON-
 *     stringified blob, citation lookup) and bundles LESS where we want
 *     more (notes are NOT in the 360 loader; the optional `question`
 *     parameter has no equivalent there). Calling it would mean
 *     stringifying then re-parsing JSON for one consumer and still
 *     making separate notes + question-aware-Keeper calls. A direct
 *     parallel fan-out is the cleaner path and uses the same underlying
 *     repos.
 *   - Soft-fail every sub-load — tool NEVER throws to the model. Each
 *     section returns null on failure and the failure is surfaced via
 *     `meta.failed` + `meta.errors_by_section`.
 *   - Total latency capped at the slowest single loader by definition
 *     (all sub-loads run in parallel).
 */

import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { loadBrainForPrompt } from "@/lib/brain/retrieval";
import { retrieveFactsHybrid } from "@/lib/brain/retrieve";
import { readPerspective } from "@/lib/customer/comms-perspective-store";
import { fetchEntityReportData } from "@/lib/report/fetchers";
import { fetchTicketsForCustomer } from "@/lib/escalation/tickets";
import {
  getNote,
  listNotesByEntity,
} from "@/lib/customer/customer-notes";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const OPEN_TICKET_STATES = new Set([
  "Todo",
  "In Progress",
  "In Review",
  "Backlog",
]);
const KEEPER_HYBRID_TOPK = 10;
const NOTE_PREVIEW_CHARS = 600;
const MAX_OPEN_TICKETS = 10;

function clipPreview(s: string, max = NOTE_PREVIEW_CHARS): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export const getFullCustomerViewTool: BeaconTool = {
  name: "get_full_customer_view",
  description:
    "Pull a HOLISTIC bundle for one customer in a single call — Keeper facts, comms perspective, performance summary (YTD leads + GBP click trend + keyword count), open escalations, and notes summary. " +
    "Use this when the user asks for the FULL picture of a customer ('tell me everything about X', 'brief me on Y', 'give me the full picture of Z', 'walk me through X'). It returns one structured response covering what would otherwise take 4-5 chained read_* tool calls. Faster (one round-trip, parallel sub-loads) and more coherent (single answer informed by every section at once). " +
    "Two retrieval modes for the Keeper portion:\n" +
    "  - Pass `question` (a short phrase of what the AM is trying to learn) to get the top-10 most relevant Keeper facts (hybrid retrieval + rerank). Use this when the holistic ask has a specific intent ('brief me on X focusing on churn risk', 'tell me everything about Y especially their billing').\n" +
    "  - Omit `question` to get the full topic-clustered Keeper block (up to 40 confirmed facts). Use this for an open-ended 'tell me about X'.\n" +
    "Read-only — no approval required. Every sub-section can independently be null if its loader soft-fails or has no data; the response carries a `meta` block telling you which sections loaded vs failed. Always check `meta.loaded` before claiming a section is empty.",
  input_schema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description:
          "The customer's entity_id (UUID). Get this from lookup_customer or from the CONTEXT block.",
        minLength: 8,
      },
      question: {
        type: "string",
        description:
          "Optional — what the user is trying to learn (a short phrase, e.g., 'churn risk picture', 'billing situation', 'why their performance is dropping'). When provided, scopes Keeper retrieval to the top-10 most semantically relevant facts. Omit for a full topic-clustered Keeper dump.",
        minLength: 3,
      },
    },
    required: ["entity_id"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const entityId =
      typeof args.entity_id === "string" ? args.entity_id.trim() : "";
    const question =
      typeof args.question === "string" ? args.question.trim() : "";
    if (!entityId) {
      return { ok: false, error: "entity_id is required" };
    }

    // Resolve identity first — every other sub-load benefits from
    // cbCustomerId / bizname, and if the customer isn't on the active
    // book we want to short-circuit cleanly rather than fan out 5
    // doomed calls.
    let bizname: string | null = null;
    let cbCustomerId: string | null = null;
    let amName: string | null = null;
    try {
      const snap = await readLatestSnapshotV2();
      const customer = snap?.customers?.find((c) => c.entity_id === entityId);
      if (!customer) {
        return {
          ok: true,
          summary: `Entity ${entityId.slice(0, 8)} not on the active book — no holistic view available.`,
          data: {
            entity_id: entityId,
            found: false,
            identity: null,
            keeper: null,
            comms_perspective: null,
            performance_summary: null,
            escalations: null,
            notes_summary: null,
            meta: {
              loaded: [],
              failed: [],
              timing_ms_by_section: {},
            },
          },
        };
      }
      bizname = customer.company ?? null;
      cbCustomerId = customer.customer_id ?? null;
      amName = customer.am_name ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `snapshot lookup failed: ${msg}` };
    }

    // Per-section timing — let callers (and the activity log) see which
    // sub-load dominates total latency.
    const timing: Record<string, number> = {};
    const errors: Record<string, string> = {};
    const tStart = nowMs();

    // Keeper sub-loader. Branches on whether the caller provided a
    // question: hybrid (top-K relevance) vs topic-block (dump-all).
    async function loadKeeper(): Promise<unknown> {
      const t0 = nowMs();
      try {
        if (!cbCustomerId) {
          timing.keeper = nowMs() - t0;
          return null;
        }
        if (question) {
          const result = await retrieveFactsHybrid(question, {
            customer_id: cbCustomerId,
            topK: KEEPER_HYBRID_TOPK,
            candidatesPerStage: 50,
          });
          timing.keeper = nowMs() - t0;
          const facts = result.facts.map((s) => ({
            fact_id: s.fact.fact_id,
            topic_category: s.fact.topic_category,
            topic_subcategory: s.fact.topic_subcategory,
            field_name: s.fact.field_name,
            value: s.fact.value,
            confirmed_at: s.fact.confirmed_at,
            source_type: s.fact.source_type,
            matched_via: s.matched_via,
            relevance_score: s.rerank_score,
            rrf_score: s.rrf_score,
          }));
          return {
            retrieval_mode: "hybrid",
            question,
            facts_returned: facts.length,
            facts,
          };
        }
        const brain = await loadBrainForPrompt(cbCustomerId);
        timing.keeper = nowMs() - t0;
        if (!brain || brain.prompt_block.facts_returned === 0) {
          return {
            retrieval_mode: "topic_block",
            facts_returned: 0,
            prompt_block: null,
          };
        }
        return {
          retrieval_mode: "topic_block",
          facts_returned: brain.prompt_block.facts_returned,
          facts_dropped: brain.prompt_block.facts_dropped,
          prompt_block: brain.prompt_block,
        };
      } catch (e) {
        timing.keeper = nowMs() - t0;
        errors.keeper = e instanceof Error ? e.message : String(e);
        return null;
      }
    }

    async function loadCommsPerspective(): Promise<unknown> {
      const t0 = nowMs();
      try {
        const row = await readPerspective(entityId);
        timing.comms_perspective = nowMs() - t0;
        if (!row) return null;
        return {
          sentiment: row.sentiment,
          topics: row.topics,
          substance_score: row.substance_score,
          initiator_pattern: row.initiator_pattern,
          response_latency_hours: row.response_latency_hours,
          haiku_summary: row.haiku_summary,
          conversation_arcs: row.conversation_arcs,
          computed_at: row.computed_at,
        };
      } catch (e) {
        timing.comms_perspective = nowMs() - t0;
        errors.comms_perspective = e instanceof Error ? e.message : String(e);
        return null;
      }
    }

    async function loadPerformanceSummary(): Promise<unknown> {
      const t0 = nowMs();
      try {
        const perf = await fetchEntityReportData(entityId);
        timing.performance_summary = nowMs() - t0;
        if (!perf) return null;

        // YTD leads — current calendar year.
        const currentYear = new Date().getUTCFullYear();
        const ytdLeads = perf.leads.filter((l) => {
          const ts = Date.parse(l.createdAt ?? "");
          if (!Number.isFinite(ts)) return false;
          return new Date(ts).getUTCFullYear() === currentYear;
        }).length;

        // GBP click trend — peak/current/dip computed on COMPLETE
        // months only (project memory: never compare partial current
        // month to full peak; creates false 92% drops).
        let gbpCurrent: { month: string; clicks: number } | null = null;
        let gbpPeak: { month: string; clicks: number } | null = null;
        let gbpDipPct: number | null = null;
        if (perf.gbpClicks.length > 0) {
          const series = perf.gbpClicks;
          const lastIdx = series.length - 1;
          gbpCurrent = {
            month: series[lastIdx].month,
            clicks: series[lastIdx].profileClicks,
          };
          const completed = series.slice(0, lastIdx);
          if (completed.length > 0) {
            const peakEntry = completed.reduce((acc, m) =>
              m.profileClicks > acc.profileClicks ? m : acc,
            );
            gbpPeak = {
              month: peakEntry.month,
              clicks: peakEntry.profileClicks,
            };
            if (peakEntry.profileClicks > 0) {
              gbpDipPct =
                ((gbpCurrent.clicks - peakEntry.profileClicks) /
                  peakEntry.profileClicks) *
                100;
            }
          }
        }

        // Keyword distribution — only count rankings with a real current rank.
        const ranked = perf.keywords.filter(
          (k) => typeof k.rankCurrent === "number" && k.rankCurrent! > 0,
        );
        const top3 = ranked.filter((k) => k.rankCurrent! <= 3).length;
        const top10 = ranked.filter((k) => k.rankCurrent! <= 10).length;

        return {
          identity: {
            vertical:
              perf.identity.verticalDisplay ?? perf.identity.vertical ?? null,
            city: perf.identity.city ?? null,
            state: perf.identity.state ?? null,
          },
          leads: {
            ytd: ytdLeads,
            total_window: perf.leads.length,
          },
          gbp_clicks: {
            current_month: gbpCurrent,
            peak_complete_month: gbpPeak,
            dip_pct_vs_peak: gbpDipPct,
          },
          keywords: {
            active_count: ranked.length,
            top3_count: top3,
            top10_count: top10,
          },
          review_target: perf.forecast?.reviewTarget ?? null,
        };
      } catch (e) {
        timing.performance_summary = nowMs() - t0;
        errors.performance_summary =
          e instanceof Error ? e.message : String(e);
        return null;
      }
    }

    async function loadEscalations(): Promise<unknown> {
      const t0 = nowMs();
      try {
        const tickets = await fetchTicketsForCustomer({ entityId });
        timing.escalations = nowMs() - t0;
        if (tickets.length === 0) return null;
        const open = tickets.filter((t) => OPEN_TICKET_STATES.has(t.state));
        const closed30d = tickets.filter((t) => {
          if (!["Done", "Canceled", "Duplicate"].includes(t.state)) return false;
          const c = t.completedAt || t.cancelledAt;
          if (!c) return false;
          const t0c = Date.parse(c);
          return Number.isFinite(t0c) && Date.now() - t0c < 30 * 86_400_000;
        }).length;
        return {
          open_count: open.length,
          closed_last_30d_count: closed30d,
          open: open.slice(0, MAX_OPEN_TICKETS).map((t) => ({
            identifier: t.identifier,
            title: t.title,
            state: t.state,
            classification: t.classification,
            created_at: t.createdAt,
            url: t.url,
          })),
        };
      } catch (e) {
        timing.escalations = nowMs() - t0;
        errors.escalations = e instanceof Error ? e.message : String(e);
        return null;
      }
    }

    async function loadNotesSummary(): Promise<unknown> {
      const t0 = nowMs();
      try {
        const role = ctx.role;
        const isElevated = role === "admin" || role === "manager";
        if (isElevated) {
          const all = await listNotesByEntity(entityId);
          timing.notes_summary = nowMs() - t0;
          if (all.length === 0) {
            return { scope: "all-ams", note_count: 0, notes: [] };
          }
          return {
            scope: "all-ams",
            note_count: all.length,
            notes: all.map((n) => ({
              am_name: n.am_name,
              bizname: n.bizname,
              note: clipPreview(n.note),
              updated_at: n.updated_at,
            })),
          };
        }
        if (!ctx.amName) {
          timing.notes_summary = nowMs() - t0;
          return {
            scope: "own-am",
            note_count: 0,
            am_name: null,
            note: null,
            unavailable_reason: "asker not mapped to an AM in BaseSheet",
          };
        }
        const own = await getNote(ctx.amName, entityId);
        timing.notes_summary = nowMs() - t0;
        return {
          scope: "own-am",
          am_name: ctx.amName,
          note: own
            ? {
                note: clipPreview(own.note),
                updated_at: own.updated_at,
              }
            : null,
        };
      } catch (e) {
        timing.notes_summary = nowMs() - t0;
        errors.notes_summary = e instanceof Error ? e.message : String(e);
        return null;
      }
    }

    // Parallel fan-out — total wall time becomes the slowest single
    // loader. allSettled so a thrown loader (shouldn't happen — they
    // catch internally — but defense in depth) doesn't take down the
    // rest of the response.
    const [keeperR, commsR, perfR, escR, notesR] = await Promise.allSettled([
      loadKeeper(),
      loadCommsPerspective(),
      loadPerformanceSummary(),
      loadEscalations(),
      loadNotesSummary(),
    ]);

    const keeper = keeperR.status === "fulfilled" ? keeperR.value : null;
    const commsPerspective =
      commsR.status === "fulfilled" ? commsR.value : null;
    const performanceSummary = perfR.status === "fulfilled" ? perfR.value : null;
    const escalations = escR.status === "fulfilled" ? escR.value : null;
    const notesSummary = notesR.status === "fulfilled" ? notesR.value : null;

    if (keeperR.status === "rejected") {
      errors.keeper = String(keeperR.reason);
    }
    if (commsR.status === "rejected") {
      errors.comms_perspective = String(commsR.reason);
    }
    if (perfR.status === "rejected") {
      errors.performance_summary = String(perfR.reason);
    }
    if (escR.status === "rejected") {
      errors.escalations = String(escR.reason);
    }
    if (notesR.status === "rejected") {
      errors.notes_summary = String(notesR.reason);
    }

    const sections: Array<{
      key:
        | "keeper"
        | "comms_perspective"
        | "performance_summary"
        | "escalations"
        | "notes_summary";
      value: unknown;
    }> = [
      { key: "keeper", value: keeper },
      { key: "comms_perspective", value: commsPerspective },
      { key: "performance_summary", value: performanceSummary },
      { key: "escalations", value: escalations },
      { key: "notes_summary", value: notesSummary },
    ];
    const loaded = sections.filter((s) => s.value !== null).map((s) => s.key);
    const failed = sections.filter((s) => s.value === null).map((s) => s.key);

    const totalMs = Math.round(nowMs() - tStart);

    const summary = `Full view for ${bizname ?? entityId.slice(0, 8)}: ${loaded.length}/${sections.length} sections loaded${failed.length > 0 ? ` (missing: ${failed.join(", ")})` : ""}.`;

    void logUmbrellaActivity({
      email: ctx.amEmail,
      role: ctx.role,
      am_name: ctx.amName,
      agent: "customer",
      event_name: "beacon_ai:action:get_full_customer_view",
      surface: "customer-360",
      entity_id: entityId,
      metadata: {
        tool: "get_full_customer_view",
        customer_id: cbCustomerId,
        question: question ? question.slice(0, 200) : null,
        sections_loaded: loaded,
        sections_failed: failed,
        timing_ms_by_section: timing,
        total_ms: totalMs,
      },
    });

    return {
      ok: true,
      summary,
      data: {
        entity_id: entityId,
        found: true,
        identity: {
          entity_id: entityId,
          bizname,
          am_name: amName,
          cb_customer_id: cbCustomerId,
        },
        keeper,
        comms_perspective: commsPerspective,
        performance_summary: performanceSummary,
        escalations,
        notes_summary: notesSummary,
        meta: {
          loaded,
          failed,
          timing_ms_by_section: timing,
          total_ms: totalMs,
          errors_by_section: Object.keys(errors).length > 0 ? errors : null,
        },
      },
    };
  },
};
