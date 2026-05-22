// Phase 33.D.3 + 33.E.1 — Snapshot route with read-time enrichment.
//
// Two enrichments:
//   1. HubSpot Locations record id (33.D.3)
//   2. Metabase Customer Health card (33.E.1) — composite, tier, sub-scores,
//      alerts, recommended action, refunds 60d, deeper engagement, etc.
//
// Both are cheap Postgres reads. The snapshot blob in dashboard_snapshots
// stays untouched; we merge at READ time so mapping refreshes propagate
// immediately without recompose.

import { NextRequest, NextResponse } from "next/server";
import { buildSnapshotV2 } from "@/lib/customer/refresh";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { getLocationRecordIdMap } from "@/lib/customer/hubspot-locations";
import { getHealthCardMap } from "@/lib/customer/health-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const wantRebuild = url.searchParams.get("rebuild") === "1";

  try {
    let snap = wantRebuild ? null : await readLatestSnapshotV2();
    if (!snap) {
      snap = await buildSnapshotV2();
    }

    // 33.D.3 — HubSpot Locations enrichment
    try {
      const locMap = await getLocationRecordIdMap();
      if (locMap.size > 0 && Array.isArray(snap.customers)) {
        for (const c of snap.customers) {
          const rec = locMap.get((c.entity_id || "").toLowerCase());
          if (rec) {
            c.hubspot = c.hubspot || ({} as any);
            (c.hubspot as any).hubspot_location_record_id = rec;
          }
        }
      }
    } catch (e) {
      console.warn(
        "[snapshot] Locations enrichment skipped:",
        e instanceof Error ? e.message : String(e),
      );
    }

    // 33.E.1 — Metabase health card enrichment
    try {
      const hcMap = await getHealthCardMap();
      if (hcMap.size > 0 && Array.isArray(snap.customers)) {
        for (const c of snap.customers) {
          const h = hcMap.get((c.entity_id || "").toLowerCase());
          if (h) {
            (c as any).metabase_health = h;
          }
        }
      }
    } catch (e) {
      console.warn(
        "[snapshot] Health card enrichment skipped:",
        e instanceof Error ? e.message : String(e),
      );
    }

    return NextResponse.json(snap, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
