import V2Dashboard from "@/components/customer/v2/V2Dashboard";

export const dynamic = "force-dynamic";

/**
 * Phase 2.A — AM Triage view (new). Coexists with v1 at /.
 * Once validated with AMs, this becomes the primary dashboard.
 */
export default function V2Page() {
  return <V2Dashboard />;
}
