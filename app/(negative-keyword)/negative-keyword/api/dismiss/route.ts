/**
 * Negative Keyword Beacon — dismiss alert. Phase NK-4.6.
 *
 * POST /negative-keyword/api/dismiss
 *   Body: { alert_id: string, reason?: string }
 *
 * Lets the AM clear a noise alert from their inbox. The row stays in the
 * DB (so we can measure dismiss rate + tune the keyword lexicon over
 * time) but flips into the dismissed bucket — invisible from the
 * default "open" filter.
 *
 * Auth + scope:
 *   - role=am must match alert.owning_am_email
 *   - role=manager/admin bypasses scope
 *
 * Idempotency: dismissing an already-dismissed alert is a no-op success.
 * Doesn't refuse — the AM may have clicked dismiss twice.
 *
 * Logs `alert_dismissed` activity event.
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { logUmbrellaActivity } from "@/lib/activity/log";
import { getAlertById, markDismissed } from "@/lib/negative-keyword/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: { alert_id?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as { alert_id?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const alertId = typeof body.alert_id === "string" ? body.alert_id.trim() : "";
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : null;

  if (!alertId) {
    return NextResponse.json(
      { ok: false, error: "alert_id is required" },
      { status: 400 },
    );
  }

  const alert = await getAlertById(alertId);
  if (!alert) {
    return NextResponse.json(
      { ok: false, error: `Alert ${alertId} not found` },
      { status: 404 },
    );
  }

  if (user.role === "am" && alert.owning_am_email !== user.email) {
    return NextResponse.json(
      { ok: false, error: "Forbidden: alert is owned by another AM" },
      { status: 403 },
    );
  }

  // Idempotency — already dismissed = success no-op.
  if (alert.dismissed_at) {
    return NextResponse.json({
      ok: true,
      idempotent: true,
      message: "Alert already dismissed",
    });
  }

  await markDismissed(alert.id!, user.email, reason);

  void logUmbrellaActivity({
    email: user.email,
    role: user.role,
    am_name: user.am_name,
    agent: "negative-keyword",
    event_name: "alert_dismissed",
    surface: "negative_keyword_alerts",
    entity_id: alert.entity_id,
    metadata: {
      alert_id: alert.id,
      risk_category: alert.risk_category,
      source: alert.source,
      reason,
    },
  });

  return NextResponse.json({ ok: true });
}
