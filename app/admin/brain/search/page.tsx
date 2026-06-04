/**
 * Beacon Brain — manager admin search page.
 *
 * Manager + admin only. Filter form (subcategory + field dropdowns,
 * value text input, limit/offset) + paginated table of all matching
 * Brain facts + CSV download. Decouples deep-dive search workflows
 * from the chat surface.
 *
 * Parallel surface to the query_brain Beacon AI tool — same underlying
 * searchFacts helper. Use this when you'd rather click than chat.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail, isManagerOrAdmin } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import BrainSearchView from "./BrainSearchView";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Brain search · Admin · Beacon · Zoca",
};

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/admin/brain/search");
  }
  const role = getRoleForEmail(session.user.email);
  if (!isManagerOrAdmin(role)) {
    redirect("/");
  }

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Brain search" homeHref="/" />
      <PageViewLogger
        agent="umbrella"
        surface="auth"
        metadata={{ kind: "admin_brain_search" }}
      />
      <BrainSearchView />
    </BeaconPageShell>
  );
}
