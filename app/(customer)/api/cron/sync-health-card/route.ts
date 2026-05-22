// Phase 33.E.1 — Cron: nightly Metabase health card sync.
//
// Triggered by Vercel cron at 03:00 UTC (after HubSpot Locations sync at 02:00).
// Pulls the full 900-row card and upserts each row keyed by entity_id.
//
// Auth: same Bearer-token pattern as the other cron routes.

import { NextRequest, NextResponse } from "next/server";
import { syncHealthCard } from "@/lib/customer/health-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = req.headers.get("authorization");
  if (expected && provided !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const stats = await syncHealthCard();
    return NextResponse.json({ ok: true, stats });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cron/sync-health-card] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
