/**
 * Negative Keyword Beacon — dashboard home. Phase NK-4.
 *
 * Server shell:
 *   1. NextAuth gate (redirects to /auth/signin if unauthenticated).
 *   2. No role gate at the page level — every authenticated user can
 *      see their scoped slice. AM sees own book via the API; manager
 *      and admin see all. The scope filter is enforced in
 *      /api/alerts (lib/negative-keyword/repo.ts).
 *   3. Wraps Dashboard in BeaconPageShell so it inherits BeaconAmbient
 *      + Watchfire chrome from the rest of the umbrella.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import BeaconPageShell from "@/components/BeaconPageShell";
import PageViewLogger from "@/components/PageViewLogger";
import SuggestedActions from "@/components/ai/SuggestedActions";
import NegativeKeywordHeader from "./_components/NegativeKeywordHeader";
import Dashboard from "./_components/Dashboard";
import "./negative-keyword.css";

export const metadata = {
  title: "Negative Keyword Beacon · Zoca",
  description:
    "AI-classified negative-signal alerts across the 5 comms channels, with one-click Linear ticket creation.",
};

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }

  return (
    <BeaconPageShell>
      <PageViewLogger agent="negative-keyword" surface="negative_keyword_home" />
      <NegativeKeywordHeader />
      <SuggestedActions scope={{ kind: "inbox" }} />
      <Dashboard />
    </BeaconPageShell>
  );
}
