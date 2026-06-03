/**
 * Beacon AI Knowledge Base — admin edit-doc page.
 *
 * Admin-only. Loads the doc by id, renders the editor pre-populated.
 * On save, PATCHes /api/admin/knowledge/<id>. On delete, DELETEs and
 * routes back to the list.
 */

import { redirect, notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import { getDoc } from "@/lib/ai/knowledge";
import KnowledgeEditor from "../KnowledgeEditor";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit doc · Knowledge · Admin · Beacon · Zoca",
};

export default async function Page(props: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect(`/auth/signin?callbackUrl=/admin/knowledge/${props.params.id}`);
  }
  const role = getRoleForEmail(session.user.email);
  if (role !== "admin") {
    redirect("/");
  }

  const doc = await getDoc(props.params.id);
  if (!doc) notFound();

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Knowledge" homeHref="/" />
      <KnowledgeEditor doc={doc} />
    </BeaconPageShell>
  );
}
