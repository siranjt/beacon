import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import PerformanceLanding from "./_components/PerformanceLanding";

/**
 * Performance Beacon — landing page.
 *
 * Server component: gates on NextAuth session. If signed in, renders the
 * entity-id input form. The form itself is a client component (state +
 * useRouter) — wrapped in this server shell so we don't expose the report
 * surface to unauthed visitors.
 */
export default async function PerformanceLandingPage() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }
  return <PerformanceLanding />;
}
