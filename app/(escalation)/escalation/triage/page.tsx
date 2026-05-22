import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import BeaconPageShell from "@/components/BeaconPageShell";
import EscalationHeader from "../_components/EscalationHeader";
import TriageClient from "../_components/TriageClient";

export const metadata = {
  title: "Triage · Escalation Beacon · Zoca",
};

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }

  return (
    <BeaconPageShell>
        <EscalationHeader current="triage" />
        <div className="text-center mb-10">
          {/* Unified Watchfire heraldic hero — see /tickets/page.tsx for rationale. */}
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
            Triage by message
          </h1>
          <p className="mt-3 max-w-[560px] mx-auto text-sm text-muted2 leading-relaxed">
            Paste an escalation that arrived outside Zoca&apos;s recorded channels (forwarded email,
            Slack DM, etc). The agent identifies the customer if any hints match, pulls their
            context, then returns triage + draft reply + routing.
          </p>
        </div>
        <TriageClient />
    </BeaconPageShell>
  );
}
