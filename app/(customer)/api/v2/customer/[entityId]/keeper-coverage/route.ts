/**
 * WAVE-A-1 — Memory Score API.
 *
 *   GET /api/v2/customer/[entityId]/keeper-coverage
 *
 * Returns the per-customer Keeper coverage object — the % of FIELD_CATALOG
 * slots Keeper has authoritative facts for, weighted by category. The
 * V2BrainPanel header renders this as a KeeperChip ("72% covered"); a
 * future tooltip can fan out into per-category bars from `perCategory`.
 *
 * Session-authed (AM / manager / admin) — same access tier as the rest of
 * the Keeper read surface. Resolves entity_id → customer_id via the
 * snapshot (Keeper rows are keyed on Chargebee handle).
 *
 * Soft-fails: if the snapshot has no row for this entity OR the customer
 * has no Chargebee customer_id, the route still returns a well-formed
 * zero-coverage response so the panel chip renders ("0% covered") rather
 * than hard-erroring.
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import {
  computeCoverage,
  coverageConfidence,
  CATEGORY_WEIGHTS,
} from "@/lib/brain/coverage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ entityId: string }> },
) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;

  const { entityId } = await ctx.params;
  if (!entityId) {
    return NextResponse.json(
      { ok: false, error: "entityId is required" },
      { status: 400 },
    );
  }

  try {
    const snap = await readLatestSnapshotV2();
    const customer = snap?.customers?.find((c) => c.entity_id === entityId);
    if (!customer) {
      return NextResponse.json(
        {
          ok: true,
          entity_id: entityId,
          customer_id: null,
          coverage: {
            percent: 0,
            slotsFilled: 0,
            slotsTotal: 0,
            perCategory: {
              identity: 0,
              operational: 0,
              behavioral: 0,
              concerns: 0,
              relationship: 0,
            },
          },
          confidence: "low",
          category_weights: CATEGORY_WEIGHTS,
          reason: "entity_not_in_active_book",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const cbCustomerId = customer.customer_id;
    if (!cbCustomerId) {
      return NextResponse.json(
        {
          ok: true,
          entity_id: entityId,
          customer_id: null,
          coverage: {
            percent: 0,
            slotsFilled: 0,
            slotsTotal: 0,
            perCategory: {
              identity: 0,
              operational: 0,
              behavioral: 0,
              concerns: 0,
              relationship: 0,
            },
          },
          confidence: "low",
          category_weights: CATEGORY_WEIGHTS,
          reason: "no_chargebee_customer_id",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const coverage = await computeCoverage(cbCustomerId);
    return NextResponse.json(
      {
        ok: true,
        entity_id: entityId,
        customer_id: cbCustomerId,
        coverage,
        confidence: coverageConfidence(coverage.percent),
        category_weights: CATEGORY_WEIGHTS,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
