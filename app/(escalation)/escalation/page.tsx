import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import BeaconPageShell from "@/components/BeaconPageShell";
import EscalationsBrowser from "./_components/EscalationsBrowser";
import EscalationHeader from "./_components/EscalationHeader";
import PageViewLogger from "@/components/PageViewLogger";
import SuggestedActions from "@/components/ai/SuggestedActions";

export const metadata = {
  title: "Escalation Beacon · Zoca",
};

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }

  return (
    <BeaconPageShell>
        <PageViewLogger agent="escalation" surface="escalation_home" />
        <EscalationHeader current="home" />
        <SuggestedActions scope={{ kind: "escalation-overview" }} />
        <EscalationsBrowser />
    </BeaconPageShell>
  );
}
