/**
 * Multi-customer comparison view — Phase E-14.
 *
 * URL: /compare?entities=A,B,C
 *
 * Manager/admin only. Loads the daily snapshot, hydrates up to 3 customer
 * records by entity_id, and renders them side-by-side via V2CustomerCompare.
 *
 * Why URL-driven: this is the universal handle. The V2Dashboard checkbox
 * UX (Phase E-14.3) and the Cmd+K palette command (Phase E-14.4) both
 * navigate here with ?entities=… in the query. Slack messages, Beacon AI
 * suggestions, and copy-paste sharing all just work with a URL.
 *
 * Failure modes:
 *   - No entities param → empty state with explanation
 *   - 1 entity → empty state ("comparison needs at least 2 customers")
 *   - Unknown entity_id → render the other two, show a warning chip
 *   - All entities not in current snapshot → empty state
 *   - Non-manager/admin role → redirect to / (the launcher)
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import V2CustomerCompare from "@/components/customer/v2/V2CustomerCompare";
import type { ScoredCustomerV2 } from "@/lib/customer/types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Compare customers · Beacon · Zoca",
};

const MAX_COMPARE = 3;

type SearchParams = { entities?: string };

export default async function ComparePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // ---- Auth gate ---------------------------------------------------------
  const session = await getServerSession(authOptions);
  if (!session) {
    const qs = searchParams.entities
      ? `?entities=${encodeURIComponent(searchParams.entities)}`
      : "";
    redirect(`/auth/signin?callbackUrl=/compare${qs}`);
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? null;
  // Manager + admin only — the user explicitly scoped this feature to the
  // cross-AM roles. AMs working inside their own book don't need compare
  // (and unscoping it later is trivial if we change our mind).
  if (role !== "manager" && role !== "admin") {
    redirect("/");
  }

  // ---- Parse + cap entity_ids -------------------------------------------
  const rawIds = (searchParams.entities ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Dedupe so /compare?entities=A,A,B doesn't render the same customer twice.
  const uniqueIds = Array.from(new Set(rawIds)).slice(0, MAX_COMPARE);

  // ---- Hydrate from latest snapshot --------------------------------------
  // V2CustomerCompare needs the full ScoredCustomerV2 shape (composite,
  // stoplight, signals_v2, comms, billing, performance, hubspot, tickets,
  // lifecycle_state). Reading the latest snapshot gives us all of that in
  // one shot — no per-customer fetches needed.
  const snapshot = await readLatestSnapshotV2().catch(() => null);
  let resolved: ScoredCustomerV2[] = [];
  let missingIds: string[] = [];
  if (snapshot) {
    const byEntity = new Map<string, ScoredCustomerV2>();
    for (const c of snapshot.customers) {
      if (c.entity_id) byEntity.set(c.entity_id, c);
    }
    for (const id of uniqueIds) {
      const c = byEntity.get(id);
      if (c) resolved.push(c);
      else missingIds.push(id);
    }
  } else {
    missingIds = uniqueIds;
  }

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Compare" homeHref="/" />
      <PageViewLogger
        agent="umbrella"
        surface="launcher"
        metadata={{
          kind: "compare_view",
          requested_count: uniqueIds.length,
          resolved_count: resolved.length,
          missing_count: missingIds.length,
        }}
      />
      <V2CustomerCompare
        customers={resolved}
        missingIds={missingIds}
        requestedIds={uniqueIds}
        snapshotGeneratedAt={snapshot?.generatedAt ?? null}
      />
    </BeaconPageShell>
  );
}
