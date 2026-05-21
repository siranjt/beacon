import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { BeaconAmbient } from "@/components/BeaconAmbient";
import EscalationsBrowser from "./_components/EscalationsBrowser";
import EscalationHeader from "./_components/EscalationHeader";

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
    <main className="beacon-escalation min-h-screen bg-bg relative">
      <BeaconAmbient />
      <div className="relative z-10 px-10 py-8">
        <EscalationHeader current="home" />
        <EscalationsBrowser />
      </div>
    </main>
  );
}
