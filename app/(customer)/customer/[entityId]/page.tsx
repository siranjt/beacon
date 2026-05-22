import V2CustomerDetailClient from "@/components/customer/v2/CustomerDetail/V2CustomerDetailClient";

/**
 * Phase 28 — Customer detail page.
 *
 * Route: /customer/customer/[entityId]
 *
 * Server shell — does NO fetching itself. Hands off to the client component
 * which fetches the snapshot record, trend, actions, and (lazily) the comms
 * thread. This keeps the route lightweight and lets skeleton states render
 * instantly while the slower Metabase fetch resolves.
 */
export const dynamic = "force-dynamic";

export default function CustomerDetailPage({
  params,
}: {
  params: { entityId: string };
}) {
  return <V2CustomerDetailClient entityId={params.entityId} />;
}
