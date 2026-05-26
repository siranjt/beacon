/**
 * Phase E-18 — comms perspective API.
 *
 *   GET  /api/customer/perspective/{entity_id}
 *     - Cache read-through. If today's row exists, return it. Otherwise
 *       fetch the comms feed, run Haiku, persist + return.
 *     - Auth: AM / manager / admin.
 *     - AM users are scoped — they can only fetch their own book.
 *
 *   POST /api/customer/perspective/{entity_id}
 *     - Force-refresh. Re-runs Haiku regardless of cache.
 *     - Auth: manager / admin ONLY. Haiku calls cost money — AMs can't
 *       trigger a refresh on every page-load.
 *
 * Soft-failure: never crashes the route. If Haiku is unavailable or the
 * comms feed is empty, returns the neutral fallback (which the store
 * still persists so we don't recompute on every retry).
 */
import { NextResponse } from "next/server";
import {
  getApiUser,
  requireRole,
  requireAmScope,
} from "@/lib/customer/api-auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { getOrCompute } from "@/lib/customer/comms-perspective-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function findAmForEntity(entityId: string): Promise<string | null> {
  const snap = await readLatestSnapshotV2().catch(() => null);
  if (!snap?.customers) return null;
  const c = snap.customers.find((x) => x.entity_id === entityId);
  return c?.am_name ?? null;
}

export async function GET(
  _req: Request,
  ctx: { params: { entity_id: string } },
) {
  const entityId = ctx.params.entity_id;
  if (!entityId) {
    return NextResponse.json({ ok: false, error: "missing entity_id" }, { status: 400 });
  }
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;
  // AM scope guard — AMs only see their own book. Manager/admin bypass.
  const amName = await findAmForEntity(entityId);
  const scopeDenied = requireAmScope(user, amName);
  if (scopeDenied) return scopeDenied;

  const row = await getOrCompute(entityId);
  if (!row) {
    return NextResponse.json(
      { ok: false, error: "could not compute perspective" },
      { status: 500 },
    );
  }
  return NextResponse.json(
    { ok: true, perspective: row },
    {
      headers: {
        // Today's row is stable for the day — caching at the edge is safe.
        "Cache-Control": "private, max-age=60, stale-while-revalidate=600",
      },
    },
  );
}

export async function POST(
  _req: Request,
  ctx: { params: { entity_id: string } },
) {
  const entityId = ctx.params.entity_id;
  if (!entityId) {
    return NextResponse.json({ ok: false, error: "missing entity_id" }, { status: 400 });
  }
  const user = await getApiUser();
  // Force refresh is privileged — Haiku calls cost real money.
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const row = await getOrCompute(entityId, undefined, { forceRefresh: true });
  if (!row) {
    return NextResponse.json(
      { ok: false, error: "could not compute perspective" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, perspective: row });
}
