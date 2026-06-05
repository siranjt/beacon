/**
 * Beam memory & facts settings. Phase E-9 · Phase 2.
 *
 * Shows the user the stable facts Beam has accumulated about them.
 * They can review, delete (deactivate), or add explicit facts.
 *
 * Two ways facts land here:
 *   1. Beam's daily extraction cron — distills facts from past
 *      conversations (preference / context / behavior)
 *   2. /remember slash command in the AskPanel — adds with category
 *      "explicit", confidence 1.00
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import FactsSettings from "./FactsSettings";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Beam memory · Settings · Zoca",
};

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/settings/beacon-ai");
  }

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Settings · Beam" homeHref="/" />
      <PageViewLogger
        agent="umbrella"
        surface="launcher"
        metadata={{ kind: "beacon_ai_settings" }}
      />
      <FactsSettings />
    </BeaconPageShell>
  );
}
