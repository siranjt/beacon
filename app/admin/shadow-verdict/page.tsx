/**
 * Shadow verdict — admin comparison page.
 *
 * Manager + admin only. Top strip shows today's agreement rate +
 * 28-day trend + drift histogram + stability. Disagreements table
 * (the row that matters): every customer where the LLM disagreed
 * with the deterministic engine today, sorted by drift severity.
 *
 * Click a row → opens an entity-detail drawer with the full LLM
 * verdict, deterministic snapshot, and the 28-day verdict history.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail, isManagerOrAdmin } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import ShadowVerdictView from "./ShadowVerdictView";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Shadow verdict · Admin · Beacon · Zoca",
};

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/admin/shadow-verdict");
  }
  const role = getRoleForEmail(session.user.email);
  if (!isManagerOrAdmin(role)) {
    redirect("/");
  }

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Shadow verdict" homeHref="/" />
      <PageViewLogger
        agent="umbrella"
        surface="auth"
        metadata={{ kind: "admin_shadow_verdict" }}
      />
      <ShadowVerdictView />
    </BeaconPageShell>
  );
}
