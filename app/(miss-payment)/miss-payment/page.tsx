/**
 * Miss Payment Beacon — dashboard home.
 *
 * Server shell:
 *   1. NextAuth gate (redirects to /auth/signin if unauthenticated).
 *   2. Role gate — admin + manager only. AMs land on /miss-payment and
 *      see an access-denied panel instead of the dashboard, since the
 *      missed-invoice view is a Finance-ops surface (caller assignment,
 *      multi-month chase decisions) rather than per-AM rep workflow.
 *   3. Imports scoped V1 styles + wraps the client Dashboard in
 *      BeaconPageShell so it inherits BeaconAmbient + Watchfire chrome.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
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

  const role = getRoleForEmail(session.user?.email ?? "");
  if (role !== "admin" && role !== "manager") {
    return (
      <BeaconPageShell>
        <MissPaymentHeader />
        <div
          className="surface"
          style={{
            padding: 32,
            textAlign: "center",
            background: "#F8EFD7",
            border: "1px solid #D4C29B",
            borderRadius: 14,
          }}
        >
          <div
            style={{
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: 22,
              color: "#2B1F14",
              marginBottom: 8,
            }}
          >
            Restricted to Finance ops
          </div>
          <div style={{ color: "#6E5F50", fontSize: 14 }}>
            Miss Payment Beacon is currently scoped to admin + manager roles.
            If you need access, ping your manager.
          </div>
        </div>
      </BeaconPageShell>
    );
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
