/**
 * Admin-only endpoint that triggers a manual Keeper enrichment run.
 *
 * Wired by /admin/keeper/enrichment-status "Run now" button. Session-
 * authed (manager + admin only) — distinct from the cron route which
 * is Bearer-authed. The actual work is delegated to runMetabaseEnrichment().
 *
 * Kept under /api/admin/ instead of next to the cron route because the
 * cron route is Bearer-only by design and adding a session branch would
 * weaken its auth gate.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail, isManagerOrAdmin } from "@/lib/customer/config";
import { runMetabaseEnrichment } from "@/lib/brain/metabase-enrichment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const role = getRoleForEmail(session.user.email);
  if (!isManagerOrAdmin(role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Optional `limit_customers` body param for cautious ops smoke runs.
  let limit_customers: number | undefined;
  try {
    const body = (await req.json()) as { limit_customers?: unknown };
    if (typeof body?.limit_customers === "number" && body.limit_customers > 0) {
      limit_customers = body.limit_customers;
    }
  } catch {
    // Ignore — empty body is fine.
  }

  const t0 = Date.now();
  const result = await runMetabaseEnrichment({ limit_customers });
  return NextResponse.json(
    {
      ok: result.facts_failed === 0,
      elapsed_ms: Date.now() - t0,
      ...result,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
