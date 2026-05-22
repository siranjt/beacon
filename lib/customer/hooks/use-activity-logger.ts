// Phase 33.B — Client-side activity logger hook.
//
// Usage:
//
//   const logEvent = useActivityLogger();
//
//   // On page mount:
//   useEffect(() => {
//     logEvent("page_view", { surface: "v2_dashboard" });
//   }, [logEvent]);
//
//   // On a button click:
//   <button onClick={() => {
//     logEvent("customer_opened", {
//       surface: "v2_dashboard",
//       entity_id: customer.entity_id,
//       metadata: { tier: customer.tier },
//     });
//     // ...do the actual nav
//   }}>Open</button>
//
// Design notes:
//   - Fire-and-forget. We don't await — UI stays snappy even if the network
//     hiccups. Failures are silently dropped (server logs them).
//   - sendBeacon() is used when available for best reliability on unload;
//     otherwise we fall back to fetch with keepalive: true.
//   - No-op if there's no session — the server-side requireRole gate will 401
//     and that's fine.

"use client";

import { useCallback } from "react";

type ActivityEventName =
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
  | "coaching_dismissed";

type ActivitySurface =
  | "v2_dashboard"
  | "v2_customer_detail"
  | "v2_manager_1on1"
  | "v2_coaching"
  | "v2_timeline"
  | "admin_usage";

interface LogEventOptions {
  surface?: ActivitySurface;
  entity_id?: string;
  metadata?: Record<string, unknown>;
}

export function useActivityLogger() {
  return useCallback((event_name: ActivityEventName, opts: LogEventOptions = {}) => {
    const payload = JSON.stringify({
      event_name,
      surface: opts.surface,
      entity_id: opts.entity_id,
      metadata: opts.metadata,
    });

    try {
      // Prefer sendBeacon for fire-and-forget — works even during pagehide.
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        const blob = new Blob([payload], { type: "application/json" });
        const ok = navigator.sendBeacon("/api/v2/activity", blob);
        if (ok) return;
      }
      // Fallback: fetch with keepalive so it survives nav.
      void fetch("/api/v2/activity", {
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
  }, []);
}
