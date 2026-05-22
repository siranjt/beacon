import V2SnapshotTimelinePageClient from "@/components/customer/v2/CustomerDetail/V2SnapshotTimelinePageClient";

/**
 * Phase 30 — Standalone snapshot-timeline page.
 *
 * Route: /customer/[entityId]/timeline
 *
 * Server shell — does NO fetching itself. Hands off to the client component
 * which fetches the customer record + timeline payload and renders the
 * full-variant V2SnapshotTimeline plus an Events log below.
 */
export const dynamic = "force-dynamic";

export default function CustomerTimelinePage({
  params,
}: {
  params: { entityId: string };
}) {
  return <V2SnapshotTimelinePageClient entityId={params.entityId} />;
}
