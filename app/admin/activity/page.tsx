/**
 * Activity log admin viewer. Phase E-9.
 *
 * Admin-only page that lets us audit who's doing what across the umbrella
 * without bouncing through the hourly Slack digest. Filters by user /
 * agent / event / surface / date range; CSV export for ad-hoc analysis.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import ActivityLogViewer from "./ActivityLogViewer";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Activity log · Admin · Beacon · Zoca",
};

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/admin/activity");
  }
  const role = getRoleForEmail(session.user.email);
  if (role !== "admin") {
    // Non-admins land back at the launcher. Could also render a 403 page,
    // but redirect is friendlier and avoids leaking that this surface exists.
    redirect("/");
  }

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Activity" homeHref="/" />
      <PageViewLogger agent="umbrella" surface="auth" metadata={{ kind: "admin_activity" }} />
      <ActivityLogViewer />
    </BeaconPageShell>
  );
}
