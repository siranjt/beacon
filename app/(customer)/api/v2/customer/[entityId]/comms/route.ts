import { NextRequest, NextResponse } from "next/server";
import { fetchCommsForEntity } from "@/lib/customer/comms-for-entity";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { getApiUser, requireAmScope, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Metabase comms CSV fetch is slow (3-10s per channel × 5 channels). Bump the
// function timeout so Vercel doesn't kill it. Pro tier supports up to 300s;
// Hobby tier caps at 10s so this route will exceed on Hobby.
export const maxDuration = 300;

/**
 * GET /api/v2/customer/:entityId/comms?days=90
 *   → live-fetches the 5 Metabase comms CSVs, filters to one entity, and
 *     returns events newest-first. Soft-fails to events:[] on Metabase error.
 *
 * Phase 33.B — admin + manager bypass; AMs scoped to customers in their book.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: { entityId: string } },
) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  const { entityId } = ctx.params;
  const url = new URL(req.url);
  const daysRaw = Number(url.searchParams.get("days") || 90);
  const days = Math.max(
    1,
    Math.min(180, Number.isFinite(daysRaw) ? Math.floor(daysRaw) : 90),
  );
  try {
    const snap = await readLatestSnapshotV2();
    if (!snap) {
      return NextResponse.json(
        { ok: false, error: "No snapshot available yet", events: [] },
        { status: 503 },
      );
    }
    const customer = snap.customers.find((c) => c.entity_id === entityId);
    if (!customer) {
      return NextResponse.json(
        { ok: false, error: "Customer not found in latest snapshot", events: [] },
        { status: 404 },
      );
    }
    const scopeDenied = requireAmScope(user, customer.am_name);
    if (scopeDenied) return scopeDenied;

    const events = await fetchCommsForEntity(entityId, days);
    return NextResponse.json(
      {
        ok: true,
        generatedAt: new Date().toISOString(),
        entityId,
        daysBack: days,
        events,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        error: msg,
        entityId,
        daysBack: days,
        events: [],
      },
      { status: 500 },
    );
  }
}
