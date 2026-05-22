import { neon, NeonQueryFunction } from "@neondatabase/serverless";
import { pgConfigured } from "./config";

/**
 * Phase 2.0 — intermediate pipeline state.
 *
 * The cron pipeline is split into 4 functions:
 *   stage A — Chargebee subs/invoices/transactions + BaseSheet + billing metrics
 *   stage B — comms (5 CSVs) → per-entity comms metrics
 *   stage C — Mixpanel + performance cards → per-entity usage + perf metrics
 *   compose — read all 3 states, score active entities, write final snapshot
 *
 * Each stage writes its slice to `pipeline_state` (composite PK: date + stage).
 * Compose reads from there. This lets each function fit comfortably under
 * Vercel Hobby's 60s timeout.
 */

export type PipelineStage = "A" | "B" | "C" | "D";

let _sql: NeonQueryFunction<false, false> | null = null;
function getSql(): NeonQueryFunction<false, false> | null {
  if (!pgConfigured()) return null;
  if (!_sql) _sql = neon(process.env.POSTGRES_URL!);
  return _sql;
}


/**
 * Phase 13.1 — expand stage CHECK constraint to allow 'D' for HubSpot stage.
 * Idempotent: DROP IF EXISTS no-ops if not present, ADD re-asserts the rule.
 * Cached so we run the two ALTERs once per cold start, not on every write.
 */
let _stageDConstraintReady = false;
async function ensureStageDConstraint(): Promise<void> {
  if (_stageDConstraintReady) return;
  const sql = getSql();
  if (!sql) return;
  try {
    await sql`ALTER TABLE pipeline_state DROP CONSTRAINT IF EXISTS pipeline_state_stage_check`;
    await sql`ALTER TABLE pipeline_state ADD CONSTRAINT pipeline_state_stage_check CHECK (stage IN ('A', 'B', 'C', 'D'))`;
    _stageDConstraintReady = true;
  } catch (e) {
    console.warn("[pipeline-state] could not expand stage CHECK constraint:", e);
  }
}

export type StageWriteOptions = {
  durationMs: number;
  errors?: string[];
  rowCount?: number | null;
};

/**
 * Write/upsert a stage's intermediate state.
 * Idempotent — re-running a stage replaces the prior row.
 */
export async function writePipelineStage(
  stage: PipelineStage,
  snapshotDate: string,
  data: unknown,
  opts: StageWriteOptions,
): Promise<void> {
  const sql = getSql();
  if (!sql) throw new Error("[pipeline-state] POSTGRES_URL not set");

  await ensureStageDConstraint();

  const errors = opts.errors ?? [];
  const rowCount = opts.rowCount ?? null;

  await sql`
    INSERT INTO pipeline_state (snapshot_date, stage, data, duration_ms, errors, row_count)
    VALUES (
      ${snapshotDate},
      ${stage},
      ${JSON.stringify(data)}::jsonb,
      ${opts.durationMs},
      ${JSON.stringify(errors)}::jsonb,
      ${rowCount}
    )
    ON CONFLICT (snapshot_date, stage) DO UPDATE SET
      data = EXCLUDED.data,
      generated_at = NOW(),
      duration_ms = EXCLUDED.duration_ms,
      errors = EXCLUDED.errors,
      row_count = EXCLUDED.row_count
  `;
  console.log(
    `[pipeline-state] wrote stage ${stage} for ${snapshotDate} ` +
      `(${opts.durationMs}ms, rows=${rowCount ?? "n/a"}, errors=${errors.length})`,
  );
}

export type StageReadResult<T = unknown> = {
  data: T;
  generatedAt: string;
  durationMs: number;
  errors: string[];
  rowCount: number | null;
};

export async function readPipelineStage<T = unknown>(
  stage: PipelineStage,
  snapshotDate: string,
): Promise<StageReadResult<T> | null> {
  const sql = getSql();
  if (!sql) return null;
  const rows = await sql`
    SELECT data, generated_at, duration_ms, errors, row_count
    FROM pipeline_state
    WHERE snapshot_date = ${snapshotDate} AND stage = ${stage}
  `;
  if (!rows.length) return null;
  const r = rows[0] as any;
  return {
    data: r.data as T,
    generatedAt:
      typeof r.generated_at === "string"
        ? r.generated_at
        : new Date(r.generated_at).toISOString(),
    durationMs: Number(r.duration_ms || 0),
    errors: Array.isArray(r.errors) ? r.errors : [],
    rowCount: r.row_count === null ? null : Number(r.row_count),
  };
}

/**
 * Read all three stages for a date. Reports which (if any) are missing —
 * compose uses this to fail loudly when an upstream stage hasn't run.
 */
export async function readAllPipelineStages(snapshotDate: string): Promise<{
  a: StageReadResult<unknown> | null;
  b: StageReadResult<unknown> | null;
  c: StageReadResult<unknown> | null;
  d: StageReadResult<unknown> | null;
  missing: PipelineStage[];
  staleStages: PipelineStage[];
}> {
  const [a, b, c, d] = await Promise.all([
    readPipelineStage("A", snapshotDate),
    readPipelineStage("B", snapshotDate),
    readPipelineStage("C", snapshotDate),
    readPipelineStage("D", snapshotDate),
  ]);
  const missing: PipelineStage[] = [];
  if (!a) missing.push("A");
  if (!b) missing.push("B");
  if (!c) missing.push("C");
  // Stage D is OPTIONAL — only required when HubSpot integration is wired.
  // composeSnapshot treats missing D as "no HubSpot data this run" and proceeds.

  // Mark stages as "stale" if their generated_at is > 6h ago.
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  const staleStages: PipelineStage[] = [];
  if (a && Date.parse(a.generatedAt) < sixHoursAgo) staleStages.push("A");
  if (b && Date.parse(b.generatedAt) < sixHoursAgo) staleStages.push("B");
  if (c && Date.parse(c.generatedAt) < sixHoursAgo) staleStages.push("C");
  if (d && Date.parse(d.generatedAt) < sixHoursAgo) staleStages.push("D");

  return { a, b, c, d, missing, staleStages };
}

/**
 * Retention helper — keep last N days of pipeline state, drop the rest.
 * Run from the daily prune cron alongside dashboard_snapshots pruning.
 */
export async function prunePipelineStateOlderThan(daysToKeep: number): Promise<number> {
  const sql = getSql();
  if (!sql) return 0;
  const rows = await sql`
    DELETE FROM pipeline_state
    WHERE snapshot_date < (CURRENT_DATE - (${daysToKeep}::int * INTERVAL '1 day'))
    RETURNING snapshot_date, stage
  `;
  console.log(`[pipeline-state] pruned ${rows.length} rows older than ${daysToKeep}d`);
  return rows.length;
}

/** Helper: today's snapshot_date in YYYY-MM-DD (UTC) */
export function todaySnapshotDate(): string {
  return new Date().toISOString().slice(0, 10);
}
