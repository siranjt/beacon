import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { searchFacts } from "@/lib/brain/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v2/brain/search
 *
 * Manager + admin search over the Brain. Same underlying searchFacts
 * helper that powers the query_brain Beacon AI tool, but exposed as
 * a JSON endpoint for the /admin/brain/search page.
 *
 * Query params (all optional; at least one required):
 *   - topic_category (identity | operational | behavioral | concerns)
 *   - topic_subcategory (e.g. comms_preference, contract)
 *   - field_name (e.g. preferred_channel, contract_start, "other")
 *   - value_contains (case-insensitive substring)
 *   - limit (default 50, max 500)
 *   - offset (default 0)
 *
 * Response:
 *   {
 *     rows: Array<{ fact_id, customer_id, entity_id, bizname, am_name,
 *                   topic_category, topic_subcategory, field_name,
 *                   value, source_type, confirmed_at }>,
 *     total: number,
 *     offset: number,
 *     limit: number,
 *     has_more: boolean,
 *   }
 */
export async function GET(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const url = new URL(req.url);
  const topic_category = url.searchParams.get("topic_category") || undefined;
  const topic_subcategory =
    url.searchParams.get("topic_subcategory") || undefined;
  const field_name = url.searchParams.get("field_name") || undefined;
  const value_contains = url.searchParams.get("value_contains") || undefined;
  const limit = Math.max(
    1,
    Math.min(500, Number(url.searchParams.get("limit") || 50)),
  );
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));

  if (
    !topic_category &&
    !topic_subcategory &&
    !field_name &&
    !value_contains
  ) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "At least one filter required (topic_category, topic_subcategory, field_name, or value_contains).",
      },
      { status: 400 },
    );
  }

  try {
    const { rows: facts, total } = await searchFacts({
      topic_category,
      topic_subcategory,
      field_name,
      value_contains,
      limit,
      offset,
    });

    // Join to snapshot for bizname/am_name.
    const snap = await readLatestSnapshotV2();
    const byCustomerId = new Map<
      string,
      { bizname: string | null; am_name: string | null; entity_id: string | null }
    >();
    if (snap?.customers) {
      for (const c of snap.customers) {
        if (!c.customer_id) continue;
        if (!byCustomerId.has(c.customer_id)) {
          byCustomerId.set(c.customer_id, {
            bizname: c.company ?? null,
            am_name: c.am_name ?? null,
            entity_id: c.entity_id ?? null,
          });
        }
      }
    }

    const rows = facts.map((f) => {
      const join = byCustomerId.get(f.customer_id);
      return {
        fact_id: f.fact_id,
        customer_id: f.customer_id,
        entity_id: join?.entity_id ?? null,
        bizname: join?.bizname ?? null,
        am_name: join?.am_name ?? null,
        topic_category: f.topic_category,
        topic_subcategory: f.topic_subcategory,
        field_name: f.field_name,
        value: f.value,
        source_type: f.source_type,
        confirmed_at: f.confirmed_at,
      };
    });

    return NextResponse.json(
      {
        ok: true,
        rows,
        total,
        offset,
        limit,
        has_more: total > offset + rows.length,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
