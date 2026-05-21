import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import EscalationsBrowser from "../_components/EscalationsBrowser";
import EscalationHeader from "../_components/EscalationHeader";

export const metadata = {
  title: "Customer 360 · Zoca",
};

export const dynamic = "force-dynamic";

/**
 * /escalation/escalations — alias of /escalation (Customer 360 home).
 * Kept for backwards compatibility with bookmarks from the standalone deploy.
 */
export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }

  return (
    <main className="min-h-screen bg-bg">
      <div className="mx-auto max-w-[1480px] px-8 py-8">
        <EscalationHeader current="home" />
        <EscalationsBrowser />
      </div>
    </main>
  );
}
