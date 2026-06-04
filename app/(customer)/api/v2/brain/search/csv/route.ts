import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { searchFacts } from "@/lib/brain/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/v2/brain/search/csv
 *
 * Same filter shape as /api/v2/brain/search, but returns the full
 * matching result set (up to a hard cap of 5000 rows) as a CSV file
 * for download. Manager + admin only.
 *
 * Lets a manager export "all customers where field X contains Y" for
 * out-of-app workflows (1:1 prep, spreadsheet pivots, paste into Slack).
 */
const CSV_HARD_LIMIT = 5000;

function escapeCsv(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

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

  if (
    !topic_category &&
    !topic_subcategory &&
    !field_name &&
    !value_contains
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "At least one filter required.",
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
      limit: CSV_HARD_LIMIT,
      offset: 0,
    });

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

    // Build CSV.
    const headers = [
      "bizname",
      "am_name",
      "customer_id",
      "entity_id",
      "topic_category",
      "topic_subcategory",
      "field_name",
      "value",
      "source_type",
      "confirmed_at",
    ];
    const lines: string[] = [headers.join(",")];
    for (const f of facts) {
      const join = byCustomerId.get(f.customer_id);
      lines.push(
        [
          escapeCsv(join?.bizname),
          escapeCsv(join?.am_name),
          escapeCsv(f.customer_id),
          escapeCsv(join?.entity_id),
          escapeCsv(f.topic_category),
          escapeCsv(f.topic_subcategory),
          escapeCsv(f.field_name),
          escapeCsv(f.value),
          escapeCsv(f.source_type),
          escapeCsv(f.confirmed_at),
        ].join(","),
      );
    }
    if (total > facts.length) {
      lines.push(
        `# NOTE: ${total - facts.length} additional rows omitted (CSV capped at ${CSV_HARD_LIMIT}). Narrow the filter to export everything.`,
      );
    }

    const filterSlug = [
      topic_category,
      topic_subcategory,
      field_name,
      value_contains ? `~${value_contains}` : null,
    ]
      .filter(Boolean)
      .join("_")
      .replace(/[^a-zA-Z0-9_~-]/g, "-")
      .slice(0, 80) || "search";

    const filename = `brain-search-${filterSlug}-${new Date().toISOString().slice(0, 10)}.csv`;

    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
