"use client";

/**
 * Umbrella-wide activity logger hook. Phase E-8.
 *
 * Usage (any agent — customer / performance / escalation / post-payment):
 *
 *   const log = useActivityLogger("performance");
 *
 *   useEffect(() => {
 *     log("page_view", { surface: "performance_landing" });
 *   }, [log]);
 *
 *   <button onClick={() => {
 *     log("recent_report_clicked", {
 *       surface: "performance_landing",
 *       metadata: { customer_id: id, report_id: rid },
 *     });
 *     // ...do the actual nav
 *   }}>Open</button>
 *
 * Notes:
 *   - Fire-and-forget. Failures are silently dropped — UI stays snappy.
 *   - Uses sendBeacon() when available so the event still ships if the user
 *     clicks away mid-fetch. Falls back to fetch with keepalive: true.
 *   - The endpoint defaults to /api/activity (umbrella-wide). Customer Beacon
 *     also accepts the legacy /api/v2/activity for back-compat — pass it as
 *     the second argument if you have a customer-only call site that already
 *     bound to that URL.
 */

import { useCallback } from "react";
import type { Agent, AnyEvent, AnySurface } from "@/lib/activity/types";

interface LogEventOptions {
  surface?: AnySurface | string;
  entity_id?: string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_ENDPOINT = "/api/activity";

export function useActivityLogger(
  agent: Agent,
  endpoint: string = DEFAULT_ENDPOINT,
) {
  return useCallback(
    (event_name: AnyEvent | string, opts: LogEventOptions = {}) => {
      const payload = JSON.stringify({
        agent,
        event_name,
        surface: opts.surface,
        entity_id: opts.entity_id,
        metadata: opts.metadata,
      });

      try {
        // Prefer sendBeacon — survives page unloads.
        if (typeof navigator !== "undefined" && navigator.sendBeacon) {
          const blob = new Blob([payload], { type: "application/json" });
          const ok = navigator.sendBeacon(endpoint, blob);
          if (ok) return;
        }
        // Fallback: fetch with keepalive so it survives nav.
        void fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(() => {
          /* swallow — logging failures should never affect the UI */
        });
      } catch {
        /* swallow */
      }
    },
    [agent, endpoint],
  );
}
