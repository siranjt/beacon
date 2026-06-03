/**
 * Beacon AI Knowledge Base — admin list page.
 *
 * Admin-only. Shows all docs in the KB with search + scope filter. Add
 * button routes to /admin/knowledge/new; row clicks route to
 * /admin/knowledge/<id>.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import { listDocs } from "@/lib/ai/knowledge";
import KnowledgeListView from "./KnowledgeListView";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Knowledge base · Admin · Beacon · Zoca",
};

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/admin/knowledge");
  }
  const role = getRoleForEmail(session.user.email);
  if (role !== "admin") {
    redirect("/");
  }

  // Server-rendered initial list. Client component can re-fetch on
  // search/filter without a full page reload.
  const docs = await listDocs({ limit: 100 });

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Knowledge" homeHref="/" />
      <PageViewLogger agent="umbrella" surface="auth" metadata={{ kind: "admin_knowledge" }} />
      <KnowledgeListView initialDocs={docs} />
    </BeaconPageShell>
  );
}
