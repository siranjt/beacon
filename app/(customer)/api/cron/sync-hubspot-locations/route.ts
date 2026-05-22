// Phase 33.D — Cron: nightly HubSpot Locations sync.
//
// Triggered by Vercel cron at 02:00 UTC. Pulls every HubSpot Locations record
// and upserts the entity_id → location_record_id mapping into Postgres.
//
// Auth: same Bearer-token pattern as the other cron routes. Pass
//   `Authorization: Bearer $CRON_SECRET` to invoke from Vercel. The route is
//   excluded from middleware (see middleware.ts matcher).

import { NextRequest, NextResponse } from "next/server";
import { syncAllLocations } from "@/lib/customer/hubspot-locations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = req.headers.get("authorization");
  if (expected && provided !== `Bearer ${expected}`) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const stats = await syncAllLocations();
    return NextResponse.json({ ok: true, stats });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cron/sync-hubspot-locations] failed:", msg);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 },
    );
  }
}
