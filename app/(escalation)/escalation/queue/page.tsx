import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import EscalationQueue from "../_components/EscalationQueue";
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
    <main className="min-h-screen bg-bg">
      <div className="mx-auto max-w-[1480px] px-8 py-8">
        <EscalationHeader current="queue" />
        <EscalationQueue />
      </div>
    </main>
  );
}
