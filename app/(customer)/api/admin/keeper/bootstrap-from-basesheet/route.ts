/**
 * META-A2 — manual Keeper bootstrap-from-BaseSheet admin endpoint.
 *
 * One-shot catch-up for customers who were created BEFORE this code
 * shipped (i.e., the existing ~900 active book). Stage A's new-customer
 * detection only sees forward-going diffs, so the back-book needs a
 * manual sweep once at deploy time. Idempotent — safe to re-run.
 *
 * Body:
 *   { entity_ids?: string[], all_active?: boolean }
 *
 * Semantics:
 *   - entity_ids: explicit list, bootstrap only those.
 *   - all_active: pull every entity_id from latest snapshot and bootstrap.
 *   - Both: union (entity_ids ∪ all_active list).
 *   - Neither: 400.
 *
 * Auth: manager+admin only (session-authed), mirrors
 * /api/admin/shadow-verdict/refresh.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail, isManagerOrAdmin } from "@/lib/customer/config";
import {
  bootstrapKeeperForEntities,
  listActiveEntityIdsFromSnapshot,
} from "@/lib/brain/metabase-bootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const role = getRoleForEmail(session.user.email);
  if (!isManagerOrAdmin(role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Empty body — fall through to validation
  }

  const explicit = Array.isArray(body.entity_ids)
    ? (body.entity_ids as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];
  const allActive = body.all_active === true;

  if (explicit.length === 0 && !allActive) {
    return NextResponse.json(
      {
        error:
          "must provide entity_ids: string[] or all_active: true (or both)",
      },
      { status: 400 },
    );
  }

  const ids = new Set<string>(explicit);
  if (allActive) {
    try {
      const active = await listActiveEntityIdsFromSnapshot();
      for (const eid of active) ids.add(eid);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        { ok: false, error: `snapshot read failed: ${msg}` },
        { status: 500 },
      );
    }
  }

  const target = Array.from(ids);
  if (target.length === 0) {
    return NextResponse.json(
      { ok: true, entities_processed: 0, facts_written: 0, errors: [], note: "empty target list" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const started = Date.now();
  try {
    const result = await bootstrapKeeperForEntities(target);
    return NextResponse.json(
      {
        ok: true,
        elapsed_ms: Date.now() - started,
        target_count: target.length,
        ...result,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg, elapsed_ms: Date.now() - started },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
