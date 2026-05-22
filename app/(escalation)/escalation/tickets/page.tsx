import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import TicketsBrowser from "../_components/TicketsBrowser";
import BeaconPageShell from "@/components/BeaconPageShell";
import EscalationHeader from "../_components/EscalationHeader";

export const metadata = {
  title: "All tickets · Zoca",
};

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }

  return (
    <BeaconPageShell>
        <EscalationHeader current="tickets" />
        <div className="text-center mb-10">
          {/*
            h1 unified with the canonical Watchfire heraldic hero pattern —
            Georgia serif + brand-gradient-text + responsive clamp sizing.
            Previously used `text-4xl font-extrabold` which drifted from the
            Performance + EscalationsBrowser landing register.
          */}
          <h1
            className="brand-gradient-text m-0"
            style={{
              fontFamily: 'Georgia, "Times New Roman", "Times", serif',
              fontSize: "clamp(32px, 4.5vw, 48px)",
              fontWeight: 500,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
            }}
          >
            All tickets
          </h1>
          <p className="mt-3 max-w-[640px] mx-auto text-sm text-muted2 leading-relaxed">
            Linear tickets across Finance + CX, filtered to the four escalation patterns —
            Churn, Retention Risk, Subscription Support, Paid Offboarding, and Subscription
            Cancellation. Sorted latest first.
          </p>
        </div>
        <TicketsBrowser />
    </BeaconPageShell>
  );
}
