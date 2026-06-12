/**
 * Miss Payment Beacon — dashboard home.
 *
 * Server shell:
 *   1. NextAuth gate (redirects to /auth/signin if unauthenticated).
 *   2. Role gate — 2026-06-12: opened to all roles (admin + manager + am).
 *      Previously scoped to admin + manager only as a Finance-ops surface,
 *      but the team wants AMs to see the same unpaid-invoice view their
 *      managers see (caller assignment, multi-month chase decisions are
 *      now shared visibility). Anyone with a Zoca email — which already
 *      gates sign-in via strict allowlist — lands on the dashboard.
 *   3. Imports scoped V1 styles + wraps the client Dashboard in
 *      BeaconPageShell so it inherits BeaconAmbient + Watchfire chrome.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import BeaconPageShell from "@/components/BeaconPageShell";
import PageViewLogger from "@/components/PageViewLogger";
import SuggestedActions from "@/components/ai/SuggestedActions";
import MissPaymentHeader from "./_components/MissPaymentHeader";
import Dashboard from "./_components/dashboard";
import "./miss-payment.css";

export const metadata = {
  title: "Miss Payment Beacon · Zoca",
  description: "Live Chargebee unpaid-invoice tracker for Zoca Finance ops.",
};

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }

  return (
    <BeaconPageShell>
      <PageViewLogger agent="miss-payment" surface="miss_payment_home" />
      <MissPaymentHeader />
      <SuggestedActions scope={{ kind: "miss-payment-overview" }} />
      <Dashboard />
    </BeaconPageShell>
  );
}
