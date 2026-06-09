/**
 * Shadow verdict — refresh cron. Phase SV-3.
 *
 * Daily LLM second-opinion run. Wired in vercel.json at `30 23 * * *`
 * (23:30 UTC, ~1.5h after Stage D completes so we always read against a
 * fresh snapshot).
 *
 * Query params (chunked re-runs + ops debugging — same shape as NK cron):
 *   - dry_run=1         → compute everything, write nothing
 *   - limit_entities=N  → process only N
 *   - skip_entities=N   → start from offset N
 *   - entity_ids=a,b,c  → process only those entity_ids
 *   - concurrency=N     → override default 20
 *   - run_date=YYYY-MM-DD → override run date (for backfills)
 *
 * Returns:
 *   { ok, run_date, total_in_scope, processed, upserted,
 *     agreement_count, disagreement_count, llm_self_disagreement_count,
 *     errors, elapsed_ms, dry_run }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runShadowVerdict } from "@/lib/customer/shadow-verdict/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function GET(req: NextRequest) {
  const auth = requireCronAuth(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const limitEntities = numFromParam(url.searchParams.get("limit_entities"));
  const skipEntities = numFromParam(url.searchParams.get("skip_entities"));
  const concurrencyParam = numFromParam(url.searchParams.get("concurrency"));
  const concurrency =
    concurrencyParam && concurrencyParam > 0 ? concurrencyParam : undefined;
  const entityIdsParam = url.searchParams.get("entity_ids");
  const entity_ids = entityIdsParam
    ? entityIdsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const runDateParam = url.searchParams.get("run_date") ?? undefined;

  try {
    const result = await runShadowVerdict({
      dry_run: dryRun,
      limit_entities: limitEntities ?? undefined,
      skip_entities: skipEntities ?? undefined,
      entity_ids,
      concurrency,
      run_date: runDateParam,
    });

    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[sv/cron/run] fatal:", msg);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function numFromParam(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
