"use client";

/**
 * Customer Beacon activity logger hook — Phase E-8 thin wrapper.
 *
 * Previously this file held the full implementation. The logic moved to
 * components/hooks/use-activity-logger.ts so Performance / Escalation /
 * Post-Payment can reuse it. This wrapper keeps every existing Customer
 * Beacon call site working without edits — same signature, same endpoint
 * (/api/v2/activity), and the agent is locked to "customer".
 *
 * New call sites in other agents should import directly from
 * @/components/hooks/use-activity-logger and pass their agent ID.
 */

import { useActivityLogger as useUmbrellaActivityLogger } from "@/components/hooks/use-activity-logger";

export function useActivityLogger() {
  // Customer Beacon's existing endpoint stays at /api/v2/activity (legacy
  // route). The umbrella's /api/activity route is the new default for the
  // other three agents. Both write through the same logUmbrellaActivity
  // server helper.
  return useUmbrellaActivityLogger("customer", "/api/v2/activity");
}
