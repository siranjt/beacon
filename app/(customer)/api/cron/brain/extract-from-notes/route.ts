import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { runExtractionSince } from "@/lib/brain/extract-from-notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Extraction is sequential per customer and Haiku adds ~4s/call. Vercel
// Pro caps at 800s. ~166 customers × 4s = ~11 min — over the cap, so
// backfill mode (?since=all) must be split. The daily incremental path
// only ever touches a handful of customers, fits easily.
//
// If the cron runs to the timeout, it returns partial results in the
// response body. Re-invoke with ?since=<last_seen_updated_at> to resume.
export const maxDuration = 800;

/**
 * Wave 1.5 — Keeper notes-extraction cron.
 *
 * GET /api/cron/brain/extract-from-notes
 *   Default: extract candidates from notes updated in the last 24 hours.
 *
 * GET /api/cron/brain/extract-from-notes?since=all
 *   Backfill mode: run over EVERY customer with notes. Use once, after
 *   first deploying the Validate inbox + UI. Will hit ~166 customers
 *   today (~$0.20 in Haiku, ~10 min wall time).
 *
 * GET /api/cron/brain/extract-from-notes?since=YYYY-MM-DD
 *   Re-run since a specific date. Useful for catching up after an outage.
 *
 * Scheduled in vercel.json at 03:30 UTC daily (= 09:00 AM IST). After the
 * morning AM workflow has had a chance to write notes, but before the
 * evening cadence picks up. Output stats land in the response body for
 * the Vercel cron logs.
 */
export async function GET(req: NextRequest) {
  const auth = requireCronAuth(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");

  let since: Date | null = null;
  if (sinceParam === "all") {
    since = null;
  } else if (sinceParam) {
    const d = new Date(sinceParam);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json(
        { ok: false, error: `invalid since=${sinceParam}` },
        { status: 400 },
      );
    }
    since = d;
  } else {
    // Default: last 24 hours.
    since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  // Chunking — bypasses Vercel's edge timeout on direct HTTP invocations
  // when running a manual backfill. Loop curl from the user's terminal
  // with incrementing skip until entities_attempted is 0.
  const limitParam = url.searchParams.get("limit_entities");
  const skipParam = url.searchParams.get("skip_entities");
  const limit_entities = limitParam ? Math.max(1, Number(limitParam)) : undefined;
  const skip_entities = skipParam ? Math.max(0, Number(skipParam)) : undefined;

  const result = await runExtractionSince(since, { limit_entities, skip_entities });
  return NextResponse.json(
    {
      ok: true,
      since: since ? since.toISOString() : "all_time",
      limit_entities,
      skip_entities,
      ...result,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
