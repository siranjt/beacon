/**
 * Umbrella-wide activity log writer. Phase E-8.
 *
 * Single source of truth for the INSERT into `am_activity_log`. Both the
 * customer-specific logger (lib/customer/activity.ts) and the umbrella
 * endpoint (app/api/activity/route.ts) call through here.
 *
 * Design:
 *   - Fire-and-forget. We never throw — DB hiccups cannot break a request.
 *   - role is nullable (Phase E-8 schema migration). Non-customer agents
 *     have signed-in users without a customer-beacon role.
 *   - agent column tags the source (customer/performance/escalation/
 *     post-payment/umbrella). The slack-activity-digest cron groups by it.
 */

import { getSql } from "@/lib/customer/postgres";
import type { Agent, AnyEvent, AnySurface } from "./types";

export interface LogActivityInput {
  email: string;
  /** customer-beacon role; null for non-customer-beacon users. */
  role?: "admin" | "manager" | "am" | null;
  /** Customer Beacon only — AM ownership for the actor. */
  am_name?: string | null;
  /** Which agent the event came from. Defaults to 'customer' for back-compat. */
  agent?: Agent;
  event_name: AnyEvent | string;
  surface?: AnySurface | string | null;
  entity_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function logUmbrellaActivity(input: LogActivityInput): Promise<void> {
  try {
    const {
      email,
      role = null,
      am_name = null,
      agent = "customer",
      event_name,
      surface = null,
      entity_id = null,
      metadata = null,
    } = input;

    const sql = getSql();
    if (!sql) {
      // POSTGRES_URL not configured — silently skip. Local dev without
      // Postgres shouldn't bring the app down just because we can't log.
      return;
    }

    await sql`
      INSERT INTO am_activity_log
        (email, role, am_name, agent, event_name, surface, entity_id, metadata)
      VALUES
        (${email}, ${role}, ${am_name}, ${agent}, ${event_name}, ${surface},
         ${entity_id}, ${metadata ? JSON.stringify(metadata) : null}::jsonb)
    `;
  } catch (err) {
    // Never throw — logging failures should not affect the request.
    console.warn(
      "[logUmbrellaActivity] failed to write activity row:",
      err instanceof Error ? err.message : String(err),
      "event:",
      input.event_name,
      "agent:",
      input.agent ?? "customer",
      "email:",
      input.email,
    );
  }
}
