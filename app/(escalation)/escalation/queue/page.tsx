import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import EscalationQueue from "../_components/EscalationQueue";
import { BeaconAmbient } from "@/components/BeaconAmbient";
import EscalationHeader from "../_components/EscalationHeader";

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
    <main className="beacon-escalation min-h-screen bg-bg relative">
      <BeaconAmbient />
      <div className="relative z-10 px-10 py-8">
        <EscalationHeader current="queue" />
        <EscalationQueue />
      </div>
    </main>
  );
}
