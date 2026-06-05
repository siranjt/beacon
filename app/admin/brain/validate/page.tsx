/**
 * Keeper Validate inbox — AM + manager triage of candidate facts.
 *
 * Lists every candidate (confidence_state='candidate', not deleted)
 * grouped by AM, with four actions per row: Confirm / Edit + Confirm /
 * Reject / Reclassify. Each action POSTs to
 * /api/v2/brain/validate/[fact_id] and the row disappears on success.
 *
 * Auth: AM + manager + admin. AMs see only their own book; managers
 * see everything. The server enforces; the UI just calls.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import ValidateInboxView from "./ValidateInboxView";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Keeper validate · Admin · Beacon · Zoca",
};

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/admin/brain/validate");
  }
  const role = getRoleForEmail(session.user.email);
  if (!role) {
    redirect("/");
  }

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Keeper validate" homeHref="/" />
      <PageViewLogger
        agent="umbrella"
        surface="auth"
        metadata={{ kind: "admin_brain_validate" }}
      />
      <ValidateInboxView role={role} userEmail={session.user.email} />
    </BeaconPageShell>
  );
}
