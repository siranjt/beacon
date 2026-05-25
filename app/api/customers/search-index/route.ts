/**
 * Lightweight customer search index — drives the Cmd+K command palette.
 *
 * Phase E-9 (quality).
 *
 * GET /api/customers/search-index
 *
 * Returns the minimum fields needed to search + route to a customer across
 * all four agents:
 *
 *   {
 *     customers: Array<{
 *       entity_id: string,
 *       biz_name: string,
 *       am_name: string | null,
 *       cb_customer_id: string,
 *       email: string | null,
 *     }>,
 *     generated_at: string,  // ISO timestamp of the underlying snapshot
 *   }
 *
 * Auth: any signed-in zoca user. Unlike /api/v2/snapshot (which contains
 * signals + scores + comms data and is role-gated), this endpoint exposes
 * ONLY the minimum identifiers needed for the search UI. Performance /
 * escalation / post-payment users who don't have a customer-beacon role
 * can still use the palette.
 *
 * Payload is small: 900-ish customers × ~5 short strings each = ~120 KB
 * uncompressed, well under 30 KB gzipped. Cache 5 minutes via
 * Cache-Control so subsequent palette opens don't hit Postgres.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SearchIndexEntry {
  entity_id: string;
  biz_name: string;
  am_name: string | null;
  cb_customer_id: string;
  email: string | null;
}

interface SearchIndexResponse {
  customers: SearchIndexEntry[];
  generated_at: string | null;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const snap = await readLatestSnapshotV2();
    if (!snap || !Array.isArray(snap.customers)) {
      return NextResponse.json<SearchIndexResponse>(
        { customers: [], generated_at: null },
        {
          headers: {
            // Short cache when there's no snapshot — let a re-fetch find one.
            "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
          },
        },
      );
    }

    // Strip down to just the search-relevant fields. Skip rows with no
    // entity_id (defensive — should never happen in a healthy snapshot).
    const customers: SearchIndexEntry[] = snap.customers
      .filter((c): c is typeof c & { entity_id: string } => !!c.entity_id)
      .map((c) => ({
        entity_id: c.entity_id,
        biz_name: c.company || c.entity_id,
        am_name: c.am_name ?? null,
        cb_customer_id: c.customer_id,
        email: c.email ?? null,
      }));

    return NextResponse.json<SearchIndexResponse>(
      {
        customers,
        generated_at: snap.generatedAt ?? null,
      },
      {
        headers: {
          // 5-minute browser + CDN cache. Snapshots only refresh hourly so
          // 5min is plenty fresh and saves a Postgres round-trip per open.
          "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
        },
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
