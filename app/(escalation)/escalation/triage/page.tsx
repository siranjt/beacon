import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
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
    <main className="beacon-escalation min-h-screen bg-bg">
      <div className="mx-auto max-w-[1480px] px-8 py-8">
        <EscalationHeader current="triage" />
        <div className="text-center mb-10">
          <h1 className="text-4xl font-extrabold tracking-tight">Triage by message</h1>
          <p className="mt-3 max-w-[560px] mx-auto text-sm text-muted2 leading-relaxed">
            Paste an escalation that arrived outside Zoca&apos;s recorded channels (forwarded email,
            Slack DM, etc). The agent identifies the customer if any hints match, pulls their
            context, then returns triage + draft reply + routing.
          </p>
        </div>
        <TriageClient />
      </div>
    </main>
  );
}
