import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { getFactsForCustomer } from "@/lib/brain/repo";
import type { BrainFact } from "@/lib/brain/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/brain/[entityId]
 *
 *   Read the Brain for a single customer. Returns confirmed facts grouped
 *   by topic_category, with full row metadata (source, confirmed_by,
 *   confirmed_at, version) so the panel UI can render source pills,
 *   timestamps, and a future version-history popover.
 *
 *   Resolves entity_id → customer_id internally; Brain rows are keyed on
 *   customer_id (Chargebee handle), not entity_id.
 *
 *   AM + manager + admin allowed (any authenticated team member can read
 *   the Brain for any customer in the book — read-only access is
 *   non-sensitive).
 *
 *   Response:
 *     {
 *       entity_id, customer_id, bizname,
 *       facts: BrainFact[],          // confirmed, non-sunset, non-deleted
 *       grouped: {
 *         identity: BrainFact[],
 *         operational: BrainFact[],
 *         behavioral: BrainFact[],
 *         concerns: BrainFact[],
 *       },
 *       facts_count: number,
 *     }
 */
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
    // Resolve entity_id → customer_id from snapshot.
    const snap = await readLatestSnapshotV2();
    const customer = snap?.customers?.find((c) => c.entity_id === entityId);
    if (!customer) {
      return NextResponse.json(
        {
          ok: true,
          entity_id: entityId,
          customer_id: null,
          bizname: null,
          facts: [],
          grouped: { identity: [], operational: [], behavioral: [], concerns: [], relationship: [] },
          currently_managed: null,
          facts_count: 0,
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
          bizname: customer.company ?? null,
          facts: [],
          grouped: { identity: [], operational: [], behavioral: [], concerns: [], relationship: [] },
          currently_managed: null,
          facts_count: 0,
          reason: "no_chargebee_customer_id",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const facts = await getFactsForCustomer(cbCustomerId, {
      confirmedOnly: true,
    });

    const grouped: Record<string, BrainFact[]> = {
      identity: [],
      operational: [],
      behavioral: [],
      concerns: [],
      // Wave 1.1 — relationship category.
      relationship: [],
    };
    for (const f of facts) {
      if (grouped[f.topic_category]) grouped[f.topic_category].push(f);
    }

    // Wave 1.1 — derive currently-managed-by section from snapshot.
    // These fields are not stored in beacon_brain_facts; they're shown
    // alongside the curated facts so the AM sees the full picture.
    const currentlyManaged = {
      current_am: customer.am_name || null,
      current_ae: customer.ae_name || null,
      current_pod:
        ((customer as { pod?: string | null }).pod ?? null) || null,
      current_sp: customer.sp_name || null,
    };

    return NextResponse.json(
      {
        ok: true,
        entity_id: entityId,
        customer_id: cbCustomerId,
        bizname: customer.company ?? null,
        currently_managed: currentlyManaged,
        facts,
        grouped,
        facts_count: facts.length,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
