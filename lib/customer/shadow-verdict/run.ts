/**
 * Shadow verdict — cron orchestrator. Phase SV-2/3.
 *
 * For each live-sub customer in the active book:
 *   1. Read snapshot row → deterministic tier + composite + signal chips
 *   2. Pull Customer 360 context (reuses /api/ai/ask's loader so the LLM
 *      sees exactly the same blob Beam would).
 *   3. Compose the locked audit prompt + signal blob.
 *   4. Fire Haiku, parse strict JSON, validate.
 *   5. Compute drift_severity vs deterministic, upsert one row.
 *
 * Concurrency 20. Soft-fail per entity. Returns a run summary.
 */

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { loadCustomer360Context } from "@/lib/ai/context-loaders";
// META-A5 — spend instrumentation. SV cron is disabled today (SV-DOWN-1)
// but the manual refresh endpoint still runs this path.
import { logSpend, extractUsage } from "@/lib/ai/spend-log";
import { SHADOW_VERDICT_SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import { upsertShadowVerdict } from "./repo";
import {
  driftSeverity,
  PRIMARY_DRIVERS,
  TIERS,
  type LlmVerdict,
  type PrimaryDriver,
  type Tier,
} from "./types";
import type { ScoredCustomerV2 } from "@/lib/customer/types";

const MODEL = process.env.ANTHROPIC_SHADOW_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 800;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 2,
});

export interface ShadowRunOptions {
  /** Override run date (YYYY-MM-DD). Defaults to today. */
  run_date?: string;
  /** Concurrency cap. Default 20. */
  concurrency?: number;
  /** Optional cap on entities processed (chunked re-runs). */
  limit_entities?: number;
  /** Skip the first N entities. */
  skip_entities?: number;
  /** Optional explicit entity_ids — bypasses snapshot enumeration. */
  entity_ids?: string[];
  /** Compute everything, don't write to Postgres. */
  dry_run?: boolean;
}

export interface ShadowRunResult {
  run_date: string;
  total_in_scope: number;
  processed: number;
  upserted: number;
  agreement_count: number;
  disagreement_count: number;
  llm_self_disagreement_count: number;
  errors: Array<{ entity_id: string; error: string }>;
  elapsed_ms: number;
  dry_run: boolean;
}

function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

function isPrimaryDriver(v: unknown): v is PrimaryDriver {
  return typeof v === "string" && (PRIMARY_DRIVERS as readonly string[]).includes(v);
}

function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function validateVerdict(parsed: unknown): LlmVerdict | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (!isTier(p.tier)) return null;
  if (!isPrimaryDriver(p.primary_driver)) return null;
  const confidence =
    typeof p.confidence === "number"
      ? Math.max(0, Math.min(100, Math.round(p.confidence)))
      : NaN;
  if (!Number.isFinite(confidence)) return null;
  const reasoning =
    typeof p.reasoning === "string" ? p.reasoning.trim().slice(0, 1000) : "";
  if (!reasoning) return null;
  const keySignals = Array.isArray(p.key_signals)
    ? p.key_signals
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim().slice(0, 200))
        .filter((s) => s.length > 0)
        .slice(0, 5)
    : [];
  const retentionRaw = p.retention_window_months;
  const retention_window_months =
    retentionRaw === null || retentionRaw === undefined
      ? null
      : typeof retentionRaw === "number" && Number.isFinite(retentionRaw)
        ? Math.max(0, Math.min(24, Math.round(retentionRaw)))
        : null;
  const disagreement_self_flag = p.disagreement_self_flag === true;
  return {
    tier: p.tier,
    confidence,
    reasoning,
    key_signals: keySignals,
    primary_driver: p.primary_driver,
    retention_window_months,
    disagreement_self_flag,
  };
}

/** Short serialized signal-chip summary for forensics. Captures the
 *  deterministic engine's top sub-scores + modifier flags so we can
 *  compare to the LLM's reasoning quickly without re-running scoring. */
function summarizeSignals(customer: ScoredCustomerV2): string | null {
  const sv2 = customer.signals_v2;
  if (!sv2) return null;
  const chips: string[] = [];
  if (sv2.pre_launch) chips.push("pre_launch");
  if (sv2.flag_performance) chips.push("flag:perf");
  if (sv2.flag_tickets) chips.push("flag:tix");
  // Surface any sub-score >= 60 (i.e. signalled meaningfully)
  const subScores: Array<[string, number]> = [
    ["we_silent", sv2.sig_we_silent],
    ["client_silent", sv2.sig_client_silent],
    ["response_drop", sv2.sig_response_drop],
    ["vol_collapse", sv2.sig_volume_collapse],
    ["usage", sv2.sig_usage],
    ["billing", sv2.sig_billing],
  ];
  for (const [k, v] of subScores) {
    if (v >= 60) chips.push(`${k}:${v}`);
  }
  chips.push(`traj:${sv2.trajectory_7d}`);
  return chips.length > 0 ? chips.join(",") : null;
}

async function classifyEntity(
  customer: ScoredCustomerV2,
  runDate: string,
  dryRun: boolean,
): Promise<{
  ok: boolean;
  agreement?: boolean;
  llm_self_disagreement?: boolean;
  error?: string;
}> {
  const t0 = Date.now();
  try {
    // 1. Load full Customer 360 context — same blob Beam grounds on.
    const ctx = await loadCustomer360Context(customer.entity_id);
    if (!ctx.blob) {
      return { ok: false, error: "empty context blob" };
    }

    // The deterministic stoplight (RED/YELLOW/GREEN) is what AMs see and
    // what the LLM second opinion should be measured against — NOT the
    // engagement-tier field `signals_v2.tier` (HIGH/MEDIUM/LOW), which is
    // a different axis.
    const deterministic_tier = customer.signals_v2?.stoplight as Tier;
    const deterministic_composite = customer.signals_v2?.composite ?? 0;
    if (!isTier(deterministic_tier)) {
      return { ok: false, error: `missing deterministic stoplight (got ${String(deterministic_tier)})` };
    }

    // v2: surface the plan + billing + tenure fields in the prompt header
    // so the LLM weighs operational silence correctly against billing
    // health and product type (automation-led plans need less human comms).
    const userPrompt = buildUserPrompt({
      bizname: customer.company ?? customer.entity_id.slice(0, 8),
      am_name: customer.am_name,
      deterministic_tier,
      deterministic_composite,
      mrr: customer.mrr_basesheet || null,
      plan_amount: customer.plan_amount ?? null,
      auto_collection: customer.auto_collection ?? null,
      customer_since: customer.activated_at ?? customer.ob_date ?? null,
      context_blob: ctx.blob.slice(0, 30_000), // hard cap to keep tokens bounded
    });

    if (!process.env.ANTHROPIC_API_KEY) {
      return { ok: false, error: "ANTHROPIC_API_KEY missing" };
    }

    // 2. Fire Haiku.
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SHADOW_VERDICT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
    void logSpend({
      feature: "shadow-verdict",
      model: MODEL,
      ...extractUsage(res),
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const parsed = extractJsonObject(text);
    const verdict = parsed ? validateVerdict(parsed) : null;
    if (!verdict) {
      return { ok: false, error: "Haiku returned malformed JSON" };
    }

    const agreement = verdict.tier === deterministic_tier;
    const drift = driftSeverity(verdict.tier, deterministic_tier);

    if (dryRun) {
      return { ok: true, agreement, llm_self_disagreement: verdict.disagreement_self_flag };
    }

    await upsertShadowVerdict({
      run_date: runDate,
      entity_id: customer.entity_id,
      am_name: customer.am_name,
      am_email: null, // Resolved later via auth-mapping if needed; cheap to skip
      bizname: customer.company ?? null,
      deterministic_tier,
      deterministic_composite,
      deterministic_signal_summary: summarizeSignals(customer),
      llm_tier: verdict.tier,
      llm_confidence: verdict.confidence,
      llm_reasoning: verdict.reasoning,
      llm_primary_driver: verdict.primary_driver,
      llm_retention_window_months: verdict.retention_window_months,
      llm_key_signals: verdict.key_signals,
      llm_disagreement_self_flag: verdict.disagreement_self_flag,
      agreement,
      drift_severity: drift,
      raw_llm_response: parsed,
      haiku_input_tokens: res.usage?.input_tokens ?? null,
      haiku_output_tokens: res.usage?.output_tokens ?? null,
      elapsed_ms: Date.now() - t0,
    });

    return { ok: true, agreement, llm_self_disagreement: verdict.disagreement_self_flag };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let cursor = 0;
  const laneCount = Math.max(1, Math.min(concurrency, items.length));
  const lanes: Promise<void>[] = [];
  async function lane() {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        console.warn(
          `[sv/run] worker threw at idx=${i}: ${e instanceof Error ? e.message : String(e)}`,
        );
        results[i] = undefined;
      }
    }
  }
  for (let i = 0; i < laneCount; i += 1) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

export async function runShadowVerdict(opts: ShadowRunOptions = {}): Promise<ShadowRunResult> {
  const startedAt = Date.now();
  const runDate = opts.run_date ?? new Date().toISOString().slice(0, 10);
  const concurrency = Math.max(1, opts.concurrency ?? 20);
  const dryRun = Boolean(opts.dry_run);

  const snap = await readLatestSnapshotV2();
  const fullList = snap?.customers ?? [];

  // Filter to live customers — these are the ones Customer Beacon ranks
  // and AMs work from. `cb_status` is the Chargebee live-sub indicator
  // (Stage A only writes customers whose sub state is active/in_trial/etc).
  // `lifecycle_state` is set when present; absent means the legacy
  // "active" default applies. We exclude any customer with churned_on set
  // (resurrected-from-churn keeps churned_on for context — but Stage A
  // already filters live; this is belt + suspenders).
  const live = fullList.filter((c) => {
    if (c.churned_on) return false;
    const status = (c.cb_status ?? "").toLowerCase();
    if (status === "cancelled" || status === "canceled") return false;
    return true;
  });

  let scope = live;
  if (opts.entity_ids && opts.entity_ids.length) {
    const wanted = new Set(opts.entity_ids);
    scope = live.filter((c) => wanted.has(c.entity_id));
  } else if (opts.skip_entities || opts.limit_entities) {
    const skip = Math.max(0, opts.skip_entities ?? 0);
    const limit = Math.max(0, opts.limit_entities ?? 0);
    scope = limit > 0 ? live.slice(skip, skip + limit) : live.slice(skip);
  }

  const result: ShadowRunResult = {
    run_date: runDate,
    total_in_scope: scope.length,
    processed: 0,
    upserted: 0,
    agreement_count: 0,
    disagreement_count: 0,
    llm_self_disagreement_count: 0,
    errors: [],
    elapsed_ms: 0,
    dry_run: dryRun,
  };

  await withConcurrency(scope, concurrency, async (c) => {
    const r = await classifyEntity(c, runDate, dryRun);
    result.processed += 1;
    if (r.ok) {
      if (!dryRun) result.upserted += 1;
      if (r.agreement) result.agreement_count += 1;
      else result.disagreement_count += 1;
      if (r.llm_self_disagreement) result.llm_self_disagreement_count += 1;
    } else {
      result.errors.push({ entity_id: c.entity_id, error: r.error ?? "unknown" });
    }
  });

  result.elapsed_ms = Date.now() - startedAt;
  return result;
}
