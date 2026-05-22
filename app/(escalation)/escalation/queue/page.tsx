import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import EscalationQueue from "../_components/EscalationQueue";
import BeaconPageShell from "@/components/BeaconPageShell";
import EscalationHeader from "../_components/EscalationHeader";
import PageViewLogger from "@/components/PageViewLogger";

export const metadata = {
  title: "Escalation Queue · Zoca",
};

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }

  return (
    <BeaconPageShell>
        <PageViewLogger agent="escalation" surface="escalation_queue" />
        <EscalationHeader current="queue" />
        <EscalationQueue />
    </BeaconPageShell>
  );
}
