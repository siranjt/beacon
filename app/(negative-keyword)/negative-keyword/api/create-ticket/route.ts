/**
 * Negative Keyword Beacon — single-alert ticket creation. Phase NK-3.3.
 *
 * POST /negative-keyword/api/create-ticket
 *   Body: { alert_id: string }
 *
 * Flow:
 *   1. Auth via Beacon's session gate. Any role (admin/manager/am) may
 *      create — per Phase NK design, AMs trigger from their inbox.
 *   2. Load the alert row from beacon_negative_keyword_alerts.
 *   3. AM-scope check: if the caller is role=am, the alert's
 *      owning_am_email must match their session email. Managers/admins
 *      bypass.
 *   4. Idempotency: if the alert already has ticket_id set, return that
 *      ticket without re-hitting Linear.
 *   5. Call linear.ts createRetentionTicketForAlert — preserves all 7
 *      mandatory rules.
 *   6. On success: stamp the row via markTicketed, log
 *      `ticket_created` activity event, return the ticket payload.
 *   7. On Linear-side dedup hit: surface the "duplicate" result to the
 *      caller WITHOUT stamping our row (the dashboard will show "open
 *      ticket exists" via a separate lookup).
 *   8. On error: log `ticket_creation_failed`, return 502 with details.
 *
 * No confirmation gate — click-to-create is the agreed UX (Phase NK
 * decision 2026-06-08).
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { logUmbrellaActivity } from "@/lib/activity/log";
import { getAlertById, markTicketed } from "@/lib/negative-keyword/repo";
import { createRetentionTicketForAlert } from "@/lib/negative-keyword/linear";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;
  // Type narrowing: requireRole returned null → user is non-null.
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: { alert_id?: unknown };
  try {
    body = (await req.json()) as { alert_id?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const alertId = typeof body.alert_id === "string" ? body.alert_id.trim() : "";
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

  // AM-scope check — only the AM who owns this alert can create.
  if (user.role === "am" && alert.owning_am_email !== user.email) {
    return NextResponse.json(
      {
        ok: false,
        error: "Forbidden: alert is owned by another AM",
      },
      { status: 403 },
    );
  }

  // Idempotency — if the alert already has a ticket stamped, return it.
  if (alert.ticket_id && alert.ticket_identifier && alert.ticket_url) {
    return NextResponse.json({
      ok: true,
      idempotent: true,
      ticket: {
        ticket_id: alert.ticket_id,
        ticket_identifier: alert.ticket_identifier,
        ticket_url: alert.ticket_url,
      },
    });
  }

  const result = await createRetentionTicketForAlert(alert);

  if (result.ok) {
    await markTicketed(alert.id!, {
      ticket_id: result.created.ticket_id,
      ticket_identifier: result.created.ticket_identifier,
      ticket_url: result.created.ticket_url,
      created_by_email: user.email,
    });

    void logUmbrellaActivity({
      email: user.email,
      role: user.role,
      am_name: user.am_name,
      agent: "negative-keyword",
      event_name: "ticket_created",
      surface: "negative_keyword_alerts",
      entity_id: alert.entity_id,
      metadata: {
        alert_id: alert.id,
        ticket_identifier: result.created.ticket_identifier,
        risk_category: alert.risk_category,
        source: alert.source,
      },
    });

    return NextResponse.json({
      ok: true,
      ticket: result.created,
    });
  }

  // Duplicate path — surface to caller, don't stamp our row. UI will
  // re-query open tickets to find the existing one for this entity.
  if ("skipped" in result && result.skipped) {
    void logUmbrellaActivity({
      email: user.email,
      role: user.role,
      am_name: user.am_name,
      agent: "negative-keyword",
      event_name: "ticket_creation_failed",
      surface: "negative_keyword_alerts",
      entity_id: alert.entity_id,
      metadata: {
        alert_id: alert.id,
        reason: "duplicate",
      },
    });

    return NextResponse.json(
      {
        ok: false,
        skipped: true,
        reason: "duplicate",
        message:
          "An open ticket already exists for this entity in Linear. No new ticket created.",
      },
      { status: 409 },
    );
  }

  // Hard error — log + return 502. Narrow to the {error} variant since
  // the success and duplicate branches returned above.
  const errorMessage = "error" in result ? result.error : "Unknown error";
  void logUmbrellaActivity({
    email: user.email,
    role: user.role,
    am_name: user.am_name,
    agent: "negative-keyword",
    event_name: "ticket_creation_failed",
    surface: "negative_keyword_alerts",
    entity_id: alert.entity_id,
    metadata: {
      alert_id: alert.id,
      error: errorMessage,
    },
  });

  return NextResponse.json(
    { ok: false, error: errorMessage },
    { status: 502 },
  );
}
