/**
 * Negative Keyword Beacon — cron orchestrator. Phase NK-2.8 (logic).
 *
 * Walks the BaseSheet entity list and, for each entity:
 *   1. Fetch 14 days of comms via per-entity Metabase URL.
 *   2. Pre-screen with the negative-keyword lexicon.
 *   3. Classify AI-eligible candidates via Haiku (batched 12/call).
 *   4. Classify Phone-Flagged candidates via regex fallback (no AI).
 *   5. Keep Video as Flagged context ONLY for entities that already
 *      have another alert in this run's window.
 *   6. Enrich with business_name + am_name + owning_am_email.
 *   7. Upsert into Postgres (idempotent on the dedup key).
 *
 * Concurrency: 20 entities at a time. ~30-60min per full book at this
 * concurrency, well under the 800s Vercel cap when chunked.
 *
 * Soft-fail per entity. One bad customer doesn't poison the run — we
 * log the entity id + error and move on.
 *
 * Limit knobs (via cron URL params):
 *   - `limit_entities` — process only the first N entities
 *   - `skip_entities` — skip the first N (lets ops resume after timeout)
 *   - `entity_ids` — comma-separated list — process only those
 *   - `dry_run` — compute candidates but DON'T write to Postgres
 */

import { fetchEntityCandidates } from "./feeds";
import { prescreen } from "./prescreen";
import { classifyAll } from "./classify";
import { classifyFallback } from "./analyze-fallback";
import { buildIdentityIndex } from "./enrich";
import { upsertAlert } from "./repo";
import { buildDedupKey, type CandidateMessage, type Classifier } from "./types";

export interface RunOptions {
  /** Optional cap on entities processed. Useful for chunked re-runs. */
  limit_entities?: number;
  /** Optional skip — process entity (skip_entities ... skip_entities + limit_entities). */
  skip_entities?: number;
  /** Optional explicit entity_ids list — bypasses BaseSheet enumeration. */
  entity_ids?: string[];
  /** If true, compute everything but don't write to Postgres. */
  dry_run?: boolean;
  /** Concurrency for per-entity fetch+prescreen. Default 20. */
  concurrency?: number;
}

export interface RunResult {
  total_entities_in_scope: number;
  entities_processed: number;
  entities_with_candidates: number;
  ai_candidates: number;
  ai_confirmed: number;
  ai_dropped: number;
  ai_failed_fell_back: number;
  flagged_phone: number;
  flagged_video: number;
  alerts_upserted: number;
  errors: Array<{ entity_id: string; error: string }>;
  elapsed_ms: number;
  dry_run: boolean;
}

/** Map ISO timestamp to {date: YYYY-MM-DD, time: HH:MM:SS}. */
function splitTs(ts: string): { date: string; time: string | null } {
  const dt = new Date(ts);
  if (!Number.isFinite(dt.getTime())) return { date: "1970-01-01", time: null };
  const iso = dt.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

/**
 * Per-entity processing. Pure-ish — touches Postgres only when
 * dry_run is false. Returns a per-entity tally for the run rollup.
 */
async function processEntity(
  entityId: string,
  identity: ReturnType<Awaited<ReturnType<typeof buildIdentityIndex>>["byEntityId"]["get"]>,
  dryRun: boolean,
): Promise<{
  candidates: number;
  ai_candidates: number;
  ai_confirmed: number;
  ai_dropped: number;
  ai_failed_fell_back: number;
  flagged_phone: number;
  flagged_video: number;
  upserted: number;
}> {
  const out = {
    candidates: 0,
    ai_candidates: 0,
    ai_confirmed: 0,
    ai_dropped: 0,
    ai_failed_fell_back: 0,
    flagged_phone: 0,
    flagged_video: 0,
    upserted: 0,
  };
  if (!identity) return out;

  const all = await fetchEntityCandidates(entityId);
  out.candidates = all.length;
  if (all.length === 0) return out;

  const { aiCandidates, flagCandidates, videoCandidates } = prescreen(all);
  out.ai_candidates = aiCandidates.length;

  // Stage 2 — Haiku classification on AI-eligible.
  const aiResults = await classifyAll(aiCandidates);

  // Collect the (candidate, decision) pairs we'll persist.
  const toPersist: Array<{
    msg: CandidateMessage;
    category: import("./types").RiskCategory;
    analysis: string;
    classifier: Classifier;
  }> = [];

  aiResults.forEach((r, i) => {
    const msg = aiCandidates[i];
    if (r === null) {
      // Whole batch failed — regex fallback so the alert still surfaces.
      const fb = classifyFallback(msg);
      toPersist.push({
        msg,
        category: fb.category,
        analysis: fb.analysis,
        classifier: "regex-fallback",
      });
      out.ai_failed_fell_back += 1;
      return;
    }
    if (!r.is_negative) {
      // Haiku said FP — drop, don't persist.
      out.ai_dropped += 1;
      return;
    }
    toPersist.push({
      msg,
      category: r.category,
      analysis: r.analysis,
      classifier: "ai",
    });
    out.ai_confirmed += 1;
  });

  // Phone keyword-flag — no AI per design.
  for (const msg of flagCandidates) {
    const fb = classifyFallback(msg);
    toPersist.push({
      msg,
      category: "Flagged",
      analysis: fb.analysis,
      classifier: "regex-fallback",
    });
    out.flagged_phone += 1;
  }

  // Video — Flagged context ONLY when entity has another alert in this run.
  // We only add video if at least one other candidate was confirmed above.
  if (toPersist.length > 0 && videoCandidates.length > 0) {
    for (const msg of videoCandidates) {
      toPersist.push({
        msg,
        category: "Flagged",
        analysis: `Video meeting on ${msg.created_at.slice(0, 10)} — included as context because another negative-signal alert exists in the 14-day window.`,
        classifier: "regex-fallback",
      });
      out.flagged_video += 1;
    }
  }

  if (dryRun) return out;

  // Stage 3 — persist.
  for (const p of toPersist) {
    try {
      const { date, time } = splitTs(p.msg.created_at);
      const dedup_key = buildDedupKey(
        p.msg.source,
        p.msg.entity_id,
        p.msg.message_body || "",
        p.msg.source_id || "",
      );
      const res = await upsertAlert({
        entity_id: p.msg.entity_id,
        customer_id: identity.customer_id,
        business_name: identity.business_name,
        am_name: identity.am_name,
        owning_am_email: identity.owning_am_email,
        source: p.msg.source,
        subject: null, // doc spec has subject for Email — pulled from message_body parse later if needed
        message_body: p.msg.message_body || null,
        message_date: date,
        message_time: time,
        sender: p.msg.sender_name || null,
        risk_category: p.category,
        analysis: p.analysis,
        classifier: p.classifier,
        dedup_key,
      });
      if (res) out.upserted += 1;
    } catch (e) {
      console.warn(
        `[nk/run] upsert failed for ${p.msg.entity_id} / ${p.msg.source}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  return out;
}

/**
 * Run N async functions in parallel with a max concurrency cap.
 *
 * Callers should catch their own worker errors. The `try/catch` here is
 * a safety net only — if a worker throws, the slot is left undefined and
 * a warning is logged so the run rollup can keep going.
 */
async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let cursor = 0;
  const lanes: Promise<void>[] = [];
  const laneCount = Math.max(1, Math.min(concurrency, items.length));

  async function lane() {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        console.warn(
          `[nk/run] worker threw at idx=${i}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        results[i] = undefined;
      }
    }
  }
  for (let i = 0; i < laneCount; i += 1) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

/**
 * Main public entry. Used by the cron route and (in the future) by an
 * admin trigger / backfill script.
 */
export async function runNegativeKeywordRefresh(
  opts: RunOptions = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  const dryRun = Boolean(opts.dry_run);
  const concurrency = Math.max(1, opts.concurrency ?? 20);

  // Build the per-entity identity lookup + the canonical entity list.
  const { byEntityId, entityIds: fullList } = await buildIdentityIndex();

  let scope: string[];
  if (opts.entity_ids && opts.entity_ids.length) {
    scope = opts.entity_ids.filter((e) => byEntityId.has(e));
  } else {
    const skip = Math.max(0, opts.skip_entities ?? 0);
    const limit = Math.max(0, opts.limit_entities ?? 0);
    scope = limit > 0 ? fullList.slice(skip, skip + limit) : fullList.slice(skip);
  }

  const result: RunResult = {
    total_entities_in_scope: scope.length,
    entities_processed: 0,
    entities_with_candidates: 0,
    ai_candidates: 0,
    ai_confirmed: 0,
    ai_dropped: 0,
    ai_failed_fell_back: 0,
    flagged_phone: 0,
    flagged_video: 0,
    alerts_upserted: 0,
    errors: [],
    elapsed_ms: 0,
    dry_run: dryRun,
  };

  await withConcurrency(scope, concurrency, async (entityId) => {
    try {
      const identity = byEntityId.get(entityId);
      const t = await processEntity(entityId, identity, dryRun);
      result.entities_processed += 1;
      if (t.candidates > 0) result.entities_with_candidates += 1;
      result.ai_candidates += t.ai_candidates;
      result.ai_confirmed += t.ai_confirmed;
      result.ai_dropped += t.ai_dropped;
      result.ai_failed_fell_back += t.ai_failed_fell_back;
      result.flagged_phone += t.flagged_phone;
      result.flagged_video += t.flagged_video;
      result.alerts_upserted += t.upserted;
    } catch (e) {
      result.errors.push({
        entity_id: entityId,
        error: e instanceof Error ? e.message : String(e),
      });
      result.entities_processed += 1;
    }
  });

  result.elapsed_ms = Date.now() - startedAt;
  return result;
}
