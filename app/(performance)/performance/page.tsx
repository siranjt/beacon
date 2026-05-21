import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import PerformanceLanding from "./_components/PerformanceLanding";

/**
 * Performance Beacon — landing page.
 *
 * Auth gate then renders the client-driven landing: hero + recent reports
 * (from localStorage) + inline preview that swaps on card click.
 */
export const dynamic = "force-dynamic";

export default async function PerformanceLandingPage() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }
  return <PerformanceLanding />;
}
