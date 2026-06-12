/**
 * Route-group layout for Performance Beacon.
 *
 * When `performance` is in `LOCKED_AGENTS` (lib/config.ts), every page route
 * under /performance renders the MaintenanceCurtain instead of its real
 * content. API routes are unaffected — only page routes are gated, because
 * the layout only applies to React rendering, not route handlers. Webhooks
 * and internal cross-agent calls keep working.
 *
 * To unlock: drop "performance" from LOCKED_AGENTS in lib/config.ts.
 */

import { isAgentLocked } from "@/lib/config";
import MaintenanceCurtain from "@/components/MaintenanceCurtain";

export default function PerformanceGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (isAgentLocked("performance")) {
    return (
      <MaintenanceCurtain
        agentName="Performance Beacon"
        detail="Per-customer growth and local-SEO reports will be back online soon. The rest of Beacon is unaffected."
      />
    );
  }
  return <>{children}</>;
}
