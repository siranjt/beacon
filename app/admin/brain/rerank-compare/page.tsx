/**
 * Voyage rerank A/B harness — admin page.
 *
 * Admin-only. Lets us eyeball whether swapping the Wave-1 hybrid pipeline
 * from `rerank-2.5-lite` to `rerank-2.5` (full) is worth the cost bump.
 *
 * Form takes (entity_id, query). On submit the server runs the SAME hybrid
 * pipeline (cosine + keyword → RRF merge) once, then reranks the candidates
 * twice — once per model — and ships back both top-K orderings plus a
 * Spearman agreement score. Below the form we render two side-by-side
 * tables and the score as a big number up top.
 *
 * This is gated harder than Keeper search (manager+admin) because it surfaces
 * raw fact internals AND per-model failure modes.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import RerankCompareView from "./RerankCompareView";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Keeper rerank compare · Admin · Beacon · Zoca",
};

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/admin/brain/rerank-compare");
  }
  const role = getRoleForEmail(session.user.email);
  if (role !== "admin") {
    redirect("/");
  }

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Keeper rerank compare" homeHref="/" />
      <PageViewLogger
        agent="umbrella"
        surface="auth"
        metadata={{ kind: "admin_brain_rerank_compare" }}
      />
      <RerankCompareView />
    </BeaconPageShell>
  );
}
