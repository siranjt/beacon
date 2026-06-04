import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { bootstrapBrainFromSnapshot } from "@/lib/brain/bootstrap";
import { getBrainRollup } from "@/lib/brain/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Bootstrap iterates ~900 customers and writes ~4 facts each (~3600
// upserts). Each writeBrainFact does 2-3 SQL calls. Cap at 5min to be
// safe; Vercel's default is 60s which won't be enough on first run.
export const maxDuration = 300;

/**
 * POST /api/v2/brain/bootstrap
 *
 *   Seeds the Brain with auto-confirmed facts from the latest snapshot
 *   (BaseSheet + Chargebee + location_insights data).
 *
 *   Body: { dryRun?: boolean }
 *
 *   Response:
 *     {
 *       result: BootstrapResult,
 *       rollup_before: { ... },
 *       rollup_after: { ... }   // null on dryRun
 *     }
 *
 * Manager + admin only — bootstrap writes ~3600 fact rows in a single
 * call and shouldn't be on the AM permission surface.
 *
 * Idempotent: re-runs are no-ops when the snapshot values match what's
 * already in the Brain. Safe to call any time after the nightly Stage
 * A refresh.
 *
 * Wave 1 scope: only the four high-confidence fields (sold_by_ae,
 * sold_at, contract_start, mrr_amount). Haiku extraction of
 * customer_notes ships in Wave 1.5.
 */
export async function POST(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  let body: { dryRun?: boolean } = {};
  try {
    body = (await req.json()) as { dryRun?: boolean };
  } catch {
    // empty body is fine
  }
  const dryRun = body.dryRun === true;

  try {
    const rollup_before = await getBrainRollup();
    const result = await bootstrapBrainFromSnapshot({ dryRun });
    const rollup_after = dryRun ? null : await getBrainRollup();

    return NextResponse.json(
      { dryRun, result, rollup_before, rollup_after },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * GET /api/v2/brain/bootstrap
 *
 *   Returns the current Brain rollup (counts of total / confirmed /
 *   candidate facts, customers_with_brain). Used by the future admin
 *   dashboard to render Brain health before/after bootstrap runs.
 *
 *   Manager + admin only.
 */
export async function GET() {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  try {
    const rollup = await getBrainRollup();
    return NextResponse.json(
      { rollup },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
