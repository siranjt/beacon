/**
 * Beacon AI Knowledge Base — admin new-doc page.
 *
 * Admin-only. Renders the empty editor; on save, POSTs to
 * /api/admin/knowledge and routes back to the list.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import KnowledgeEditor from "../KnowledgeEditor";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "New doc · Knowledge · Admin · Beacon · Zoca",
};

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/admin/knowledge/new");
  }
  const role = getRoleForEmail(session.user.email);
  if (role !== "admin") {
    redirect("/");
  }

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Knowledge" homeHref="/" />
      <KnowledgeEditor doc={null} />
    </BeaconPageShell>
  );
}
