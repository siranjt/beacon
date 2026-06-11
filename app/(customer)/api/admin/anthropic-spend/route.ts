/**
 * META-A5 — Admin Anthropic-spend observability endpoint.
 *
 * GET /api/admin/anthropic-spend
 *   → { mtd_usd, projected_eom_usd, alert_state, daily, per_feature, per_model }
 *
 * Admin-only. Aggregates from `beacon_anthropic_spend_log`. The dashboard
 * page reads the same builder directly via `lib/ai/spend-overview.ts`; this
 * endpoint is for external curl + monitoring access only.
 *
 * Numbers come from OUR instrumentation (Plan B in META-A5) — fresh within
 * seconds of each call. Phase 2 will cross-check against Anthropic's
 * official usage-report endpoint.
 */

import { NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { buildSpendOverview } from "@/lib/ai/spend-overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getApiUser();
  const denied = requireRole(user, "admin");
  if (denied) return denied;

  try {
    const overview = await buildSpendOverview();
    return NextResponse.json({ ok: true, overview });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
