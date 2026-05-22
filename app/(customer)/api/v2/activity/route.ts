// Phase 33.B — POST /api/v2/activity
//
// Client-side endpoint for the useActivityLogger() hook. Logs UI events
// (page_view, customer_opened, mark_contacted, etc.) keyed by the
// authenticated session.
//
// Auth: any signed-in user (admin/manager/am). The session is the source of
// truth for email/role/am_name — the client cannot spoof identity.
//
// Body shape:
//   { event_name: ActivityEvent, surface?: ActivitySurface, entity_id?: string,
//     metadata?: Record<string, unknown> }
//
// Returns: 204 No Content on success, never blocks the UI.

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { logActivity, type ActivityEvent, type ActivitySurface } from "@/lib/customer/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActivityBody = {
  event_name?: string;
  surface?: string;
  entity_id?: string;
  metadata?: Record<string, unknown>;
};

const VALID_EVENTS: ActivityEvent[] = [
  "page_view",
  "refresh_clicked",
  "filter_changed",
  "sort_changed",
  "am_switched",
  "view_switched",
  "customer_opened",
  "mark_contacted",
  "note_saved",
  "snooze_set",
  "one_on_one_opened",
  "coaching_acted",
  "coaching_dismissed",
];

const VALID_SURFACES: ActivitySurface[] = [
  "v2_dashboard",
  "v2_customer_detail",
  "v2_manager_1on1",
  "v2_coaching",
  "v2_timeline",
  "admin_usage",
];

export async function POST(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;
  // After requireRole guard, `user` is guaranteed non-null & typed.
  if (!user) return NextResponse.json({ error: "no session" }, { status: 401 });

  let body: ActivityBody | null = null;
  try {
    body = (await req.json()) as ActivityBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { event_name, surface, entity_id, metadata } = body || {};

  if (!event_name || !VALID_EVENTS.includes(event_name as ActivityEvent)) {
    return NextResponse.json(
      { error: `event_name required, must be one of: ${VALID_EVENTS.join(", ")}` },
      { status: 400 },
    );
  }
  if (surface && !VALID_SURFACES.includes(surface as ActivitySurface)) {
    return NextResponse.json(
      { error: `surface must be one of: ${VALID_SURFACES.join(", ")}` },
      { status: 400 },
    );
  }

  // Fire-and-forget; do not await — keep the endpoint snappy.
  void logActivity({
    email: user.email,
    role: user.role,
    am_name: user.am_name ?? null,
    event_name: event_name as ActivityEvent,
    surface: (surface as ActivitySurface) ?? null,
    entity_id: entity_id ?? null,
    metadata: metadata ?? null,
  });

  return new NextResponse(null, { status: 204 });
}
