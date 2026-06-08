/**
 * Negative Keyword Beacon — refresh cron. Phase NK-2.8.
 *
 * Auth: Bearer ${CRON_SECRET}. Wired in vercel.json to run every 6 hours.
 *
 * Returns a JSON summary of what was processed:
 *   {
 *     ok: true,
 *     total_entities_in_scope, entities_processed,
 *     ai_candidates, ai_confirmed, ai_dropped, ai_failed_fell_back,
 *     flagged_phone, flagged_video,
 *     alerts_upserted, errors, elapsed_ms, dry_run
 *   }
 *
 * Query params (for chunked re-runs + ops debugging):
 *   - dry_run=1         → compute everything, write nothing
 *   - limit_entities=N  → process only N
 *   - skip_entities=N   → start from offset N
 *   - entity_ids=a,b,c  → process only those entity_ids
 *   - concurrency=N     → override default 20
 *
 * maxDuration=800 — matches the Vercel Pro cap. A full book run with
 * concurrency=20 lands well under that (typical run ~3-4 min).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runNegativeKeywordRefresh } from "@/lib/negative-keyword/run";

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
  const concurrency = concurrencyParam && concurrencyParam > 0 ? concurrencyParam : undefined;
  const entityIdsParam = url.searchParams.get("entity_ids");
  const entity_ids = entityIdsParam
    ? entityIdsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  try {
    const result = await runNegativeKeywordRefresh({
      dry_run: dryRun,
      limit_entities: limitEntities ?? undefined,
      skip_entities: skipEntities ?? undefined,
      entity_ids,
      concurrency,
    });

    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[nk/cron/refresh] fatal:", msg);
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
