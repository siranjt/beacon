/**
 * Route-group layout for Post-Payment Reviews.
 *
 * When `post-payment` is in `LOCKED_AGENTS` (lib/config.ts), every page route
 * under /post-payment renders the MaintenanceCurtain instead of its real
 * content. API routes are unaffected — critically, the Stripe webhook handler
 * keeps receiving payment events, and internal cron endpoints keep firing.
 *
 * To unlock: drop "post-payment" from LOCKED_AGENTS in lib/config.ts.
 */

import { isAgentLocked } from "@/lib/config";
import MaintenanceCurtain from "@/components/MaintenanceCurtain";

export default function PostPaymentGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (isAgentLocked("post-payment")) {
    return (
      <MaintenanceCurtain
        agentName="Post-Payment Reviews"
        detail="Discovery customer ICP gating at first pay will be back online soon. The rest of Beacon is unaffected."
      />
    );
  }
  return <>{children}</>;
}
