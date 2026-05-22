/**
 * Post-Payment Reviews — dashboard home.
 *
 * Server shell: NextAuth gate → fetch customers from Postgres → hydrate
 * the client-side DashboardClient (filter/search/sort). Wrapped in the
 * umbrella's BeaconPageShell so it inherits BeaconAmbient + Watchfire
 * typography + end-to-end layout.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import BeaconPageShell from "@/components/BeaconPageShell";
import { listCustomersSinceFloor, type Customer } from "@/lib/post-payment/db/queries";
import DashboardClient from "./_components/DashboardClient";
import PageViewLogger from "@/components/PageViewLogger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }

  let customers: Customer[] = [];
  let dbError: string | null = null;
  try {
    customers = await listCustomersSinceFloor();
  } catch (e: any) {
    dbError = e.message;
  }

  if (dbError) {
    return (
      <BeaconPageShell>
        {/*
          Watchfire-skinned error block. Previously used raw Tailwind red
          tokens (border-red-500/40 bg-red-50/40 text-red-900) which leaked
          a v2 hue into an otherwise Parchment-on-Char surface. Replaced
          with accent-red (Ember) + accent-red-bg tint defined in the
          Tailwind config remap.
        */}
        <div className="rounded-2xl border border-accent-red/40 bg-accent-red-bg/30 px-5 py-4 text-sm text-accent-red mt-8">
          <strong className="text-ink">Database connection error:</strong> {dbError}
          <div className="text-xs mt-2 text-ink-muted">
            Run <code className="font-mono">npm run db:migrate</code> against POSTGRES_URL to create the schema, and verify the connection string in Vercel env vars.
          </div>
        </div>
      </BeaconPageShell>
    );
  }

  // Cast to the trimmer shape the client expects (DB type has extra fields).
  // CRITICAL: cb_created_at comes from Neon as a JS Date. Coerce to ISO
  // string here — once it crosses the server→client RSC boundary, calling
  // string methods on a Date throws and triggers a client-side exception.
  const toIso = (v: unknown): string => {
    if (!v) return "";
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "string") return v;
    try {
      return new Date(v as any).toISOString();
    } catch {
      return "";
    }
  };

  const payload = customers.map((c) => ({
    cb_customer_id: c.cb_customer_id,
    biz_name: c.biz_name,
    email: c.email,
    am_name: c.am_name,
    ae_name: c.ae_name,
    scope: c.scope,
    verdict: c.verdict,
    status: c.status,
    failure_reason: c.failure_reason,
    cb_created_at: toIso(c.cb_created_at),
    primary_category: c.primary_category,
    predicted_6_month_leads: c.predicted_6_month_leads,
  }));

  return (
    <BeaconPageShell>
      <PageViewLogger agent="post-payment" surface="post_payment_dashboard" />
      <DashboardClient customers={payload} />
    </BeaconPageShell>
  );
}
