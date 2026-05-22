// Phase 33.D.3 + 33.E.1 — Per-customer route with read-time enrichment.

import { NextRequest, NextResponse } from "next/server";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { getApiUser, requireAmScope } from "@/lib/customer/api-auth";
import { getLocationRecordIdMap } from "@/lib/customer/hubspot-locations";
import { getHealthCardMap } from "@/lib/customer/health-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: { entityId: string } },
) {
  const user = await getApiUser();
  const { entityId } = ctx.params;
  try {
    const snap = await readLatestSnapshotV2();
    if (!snap) {
      return NextResponse.json(
        { ok: false, error: "No snapshot available yet", customer: null },
        { status: 503 },
      );
    }
    const customer = snap.customers.find((c) => c.entity_id === entityId) || null;
    if (!customer) {
      return NextResponse.json(
        { ok: false, error: "Customer not found in latest snapshot", customer: null },
        { status: 404 },
      );
    }
    const denied = requireAmScope(user, customer.am_name);
    if (denied) return denied;

    const eidLower = (entityId || "").toLowerCase();

    // 33.D.3 — Locations
    try {
      const locMap = await getLocationRecordIdMap();
      const rec = locMap.get(eidLower);
      if (rec) {
        customer.hubspot = customer.hubspot || ({} as any);
        (customer.hubspot as any).hubspot_location_record_id = rec;
      }
    } catch (e) {
      console.warn(
        "[customer] Locations enrichment skipped:",
        e instanceof Error ? e.message : String(e),
      );
    }

    // 33.E.1 — health card
    try {
      const hcMap = await getHealthCardMap();
      const h = hcMap.get(eidLower);
      if (h) {
        (customer as any).metabase_health = h;
      }
    } catch (e) {
      console.warn(
        "[customer] Health card enrichment skipped:",
        e instanceof Error ? e.message : String(e),
      );
    }

    return NextResponse.json(
      { ok: true, generatedAt: snap.generatedAt, customer },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg, customer: null },
      { status: 500 },
    );
  }
}
