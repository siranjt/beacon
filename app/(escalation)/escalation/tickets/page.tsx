import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import TicketsBrowser from "../_components/TicketsBrowser";
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
    <main className="beacon-escalation min-h-screen bg-bg">
      <div className="mx-auto max-w-[1480px] px-8 py-8">
        <EscalationHeader current="tickets" />
        <div className="text-center mb-10">
          <h1 className="text-4xl font-extrabold tracking-tight">All tickets</h1>
          <p className="mt-3 max-w-[640px] mx-auto text-sm text-muted2 leading-relaxed">
            Linear tickets across Finance + CX, filtered to the four escalation patterns —
            Churn, Retention Risk, Subscription Support, Paid Offboarding, and Subscription
            Cancellation. Sorted latest first.
          </p>
        </div>
        <TicketsBrowser />
      </div>
    </main>
  );
}
