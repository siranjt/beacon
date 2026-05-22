import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import {
  readActionsNeedingOutcomeEval,
  readLatestSnapshotV2,
  writeOutcomeRow,
} from "@/lib/customer/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/cron/outcome-backfill
 *   → for each Mark Contacted action 7 / 14 / 30 days ago, look up the
 *     customer's tier in the latest snapshot and stamp a row into
 *     outcome_tracking (recovered = current tier strictly better than
 *     tier-at-action).
 *
 * Scheduled in vercel.json at 03:00 UTC daily (after the prune cron).
 */
export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  try {
    const snap = await readLatestSnapshotV2();
    if (!snap) {
      return NextResponse.json({ ok: false, error: "no snapshot" }, { status: 500 });
    }
    // Build entity → current state lookup
    const stateByEntity = new Map<string, { tier: string; composite: number }>();
    for (const c of snap.customers) {
      stateByEntity.set(c.entity_id, {
        tier: c.signals_v2.tier,
        composite: c.signals_v2.composite,
      });
    }

    // Tier ranking — lower index = healthier
    const TIER_RANK: Record<string, number> = {
      HEALTHY: 0,
      LOW: 1,
      MEDIUM: 2,
      HIGH: 3,
    };

    const windows = [7, 14, 30];
    const tally = { written: 0, recovered: 0, perWindow: {} as Record<number, number> };
    for (const days of windows) {
      tally.perWindow[days] = 0;
      const actions = await readActionsNeedingOutcomeEval(days);
      for (const a of actions) {
        if (!a.id) continue;
        const state = stateByEntity.get(a.entity_id);
        if (!state) continue;
        // tier_at_action wasn't persisted historically — best we can do is
        // back-fill from composite_at_action -> nearest tier band
        const composite_at = a.composite_at_action ?? null;
        const tierAtAction =
          composite_at === null
            ? ""
            : composite_at >= 65
              ? "HIGH"
              : composite_at >= 45
                ? "MEDIUM"
                : composite_at >= 25
                  ? "LOW"
                  : "HEALTHY";
        const recovered =
          tierAtAction !== "" &&
          TIER_RANK[state.tier] < TIER_RANK[tierAtAction];
        await writeOutcomeRow({
          action_id: a.id,
          days_after: days,
          tier_at_action: tierAtAction,
          tier_now: state.tier,
          composite_at_action: composite_at,
          composite_now: state.composite,
          recovered,
        });
        tally.written += 1;
        tally.perWindow[days] += 1;
        if (recovered) tally.recovered += 1;
      }
    }

    return NextResponse.json({ ok: true, ...tally });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const POST = GET;
