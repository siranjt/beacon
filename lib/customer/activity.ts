// Phase 33.B — Usage tracking.
//
// Single server-side helper that writes one row to `am_activity_log`.
// Used by:
//   - lib/auth-options.ts          → events.signIn callback (login attribution)
//   - lib/api-auth.ts              → inside requireRole(), logs every gated API hit
//   - app/api/v2/activity/route.ts → client-side events POSTed via useActivityLogger()
//
// Design notes:
//   - Fire-and-forget. We do NOT block the caller on logging — DB failures
//     should never break a request. Errors are console.warn-ed.
//   - We use the Neon serverless driver that's already in lib/postgres.ts.
//   - JSONB metadata is optional. Pass anything JSON-stringifiable.
//   - The table was created via SQL migration (see CLAUDE.md notes / Neon UI):
//
//     CREATE TABLE am_activity_log (
//       id BIGSERIAL PRIMARY KEY,
//       email TEXT NOT NULL,
//       role TEXT NOT NULL,
//       am_name TEXT,
//       event_name TEXT NOT NULL,
//       surface TEXT,
//       entity_id TEXT,
//       metadata JSONB,
//       ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
//     );

import type { UserRole } from "@/lib/customer/config";
import { postRealtimeAmActivity } from "./slack-am-activity";
import { logUmbrellaActivity } from "@/lib/activity/log";

export type ActivityEvent =
  | "sign_in"
  | "sign_in_rejected"
  | "page_view"
  | "refresh_clicked"
  | "filter_changed"
  | "sort_changed"
  | "am_switched"
  | "view_switched"
  | "customer_opened"
  | "mark_contacted"
  | "note_saved"
  | "snooze_set"
  | "one_on_one_opened"
  | "coaching_acted"
  | "coaching_dismissed"
  | "api_call";

export type ActivitySurface =
  | "v2_dashboard"
  | "v2_customer_detail"
  | "v2_manager_1on1"
  | "v2_coaching"
  | "v2_timeline"
  | "admin_usage"
  | "auth";

export interface LogActivityInput {
  email: string;
  role: UserRole;
  am_name?: string | null;
  event_name: ActivityEvent;
  surface?: ActivitySurface | null;
  entity_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Fire-and-forget activity logger. Never throws.
 * Use `await` if you want to make sure it lands before the response, but it's
 * safe to ignore the promise — failures are logged to console only.
 *
 * Phase E-8: now delegates to lib/activity/log.ts and sets agent: 'customer'
 * on every insert. The real-time Slack post for high-signal events still
 * fires here because the slack-am-activity formatter is Customer Beacon-
 * specific (depends on am_name + customer metadata).
 */
export async function logActivity(input: LogActivityInput): Promise<void> {
  await logUmbrellaActivity({
    email: input.email,
    role: input.role,
    am_name: input.am_name ?? null,
    agent: "customer",
    event_name: input.event_name,
    surface: input.surface ?? null,
    entity_id: input.entity_id ?? null,
    metadata: input.metadata ?? null,
  });
  // Fire-and-forget real-time Slack post (high-signal events only).
  postRealtimeAmActivity(input).catch(() => {});
}
