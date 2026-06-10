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
import { getActiveCallOutcomes, applyOutcomeOverride } from "@/lib/customer/call-outcomes";
import { getLatestShadowVerdictMap } from "@/lib/customer/shadow-verdict/repo";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  // Auth gate — the snapshot blob contains every customer's billing, comms,
  // and signals data. Previously the route had no check at all, meaning an
  // unauthenticated visitor could pull the full book. All three roles
  // (admin/manager/am) read this route from the dashboard.
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;

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

    // SV-10 — latest LLM shadow verdict per entity. Enriched here so the
    // V2CustomerCard's "AI says" chip can render directly off the snapshot
    // payload without a per-card fetch. Bounded by current customer count
    // (~900 rows), so a single DISTINCT ON query is cheap. Soft-fails when
    // the shadow_verdict table isn't yet present or the query errors.
    try {
      const svMap = await getLatestShadowVerdictMap();
      if (svMap.size > 0 && Array.isArray(snap.customers)) {
        for (const c of snap.customers) {
          const v = svMap.get(c.entity_id);
          if (v) {
            c.shadow_verdict = {
              tier: v.tier,
              run_date: v.run_date,
              primary_driver: v.primary_driver,
            };
          }
        }
      }
    } catch (e) {
      console.warn(
        "[snapshot] Shadow verdict enrichment skipped:",
        e instanceof Error ? e.message : String(e),
      );
    }

    // F-call-outcome — overlay active call outcomes. 'connected' also
    // demotes the customer's tier for the 7-day window so the "needs a
    // call" filter naturally drops them. Must run AFTER metabase_health
    // enrichment so the override has the raw tier to demote from.
    try {
      const outcomes = await getActiveCallOutcomes();
      if (outcomes.size > 0 && Array.isArray(snap.customers)) {
        snap.customers = snap.customers.map((c) =>
          applyOutcomeOverride(c, outcomes.get(c.entity_id)),
        );
      }
    } catch (e) {
      console.warn(
        "[snapshot] Call-outcome enrichment skipped:",
        e instanceof Error ? e.message : String(e),
      );
    }

    return NextResponse.json(snap, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
