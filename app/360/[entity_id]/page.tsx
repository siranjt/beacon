/**
 * Customer 360 — unified view across all four agents. Phase E-9.
 *
 * One URL (/360/{entity_id}) stitches together:
 *   - Customer Beacon signals (composite, stoplight, sub-scores, comms)
 *   - Performance Beacon metrics (GBP, keywords, leads, forecast)
 *   - Escalation tickets (open + closed-30d count)
 *   - Post-Payment verdict (ICP/Review/Not-ICP + docx link)
 *
 * Server component: gates auth, then renders the client-side
 * <Customer360 /> which calls /api/customer-360/{entity_id} for data.
 *
 * Why a client-side fetch instead of server-render: per-section
 * SectionErrorBoundaries + freshness indicators + retry need the data
 * shape to land in client state. Hydration is easier this way.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import Customer360 from "./Customer360";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Customer 360 · Beacon · Zoca",
};

export default async function Page({
  params,
}: {
  params: { entity_id: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect(`/auth/signin?callbackUrl=/360/${params.entity_id}`);
  }

  return (
    <BeaconPageShell>
      <AgentHeader agentName="360" homeHref="/" />
      <PageViewLogger
        agent="umbrella"
        surface="launcher"
        metadata={{ kind: "customer_360", entity_id: params.entity_id }}
      />
      <Customer360 entityId={params.entity_id} />
    </BeaconPageShell>
  );
}
