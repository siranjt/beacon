"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (0 hex/rgba + 6 tailwind-rose swept)

import { useEffect, useState } from "react";
import type { ScoredCustomerV2, AmActionRow } from "@/lib/customer/types";
import V2PerformancePanel from "@/components/customer/v2/V2PerformancePanel";
import V2DetailHeader from "./V2DetailHeader";
import V2ActionLogPanel from "./V2ActionLogPanel";
import V2NotesPanel from "./V2NotesPanel";
import V2BillingPanel from "./V2BillingPanel";
import V2TicketsPanel from "./V2TicketsPanel";
import V2HubspotPanel from "./V2HubspotPanel";
import V2CommsThreadPanel from "./V2CommsThreadPanel";

import { useActivityLogger } from "@/lib/customer/hooks/use-activity-logger";
type TrendPoint = { date: string; composite: number };

type Props = {
  entityId: string;
};

/**
 * Phase 28 — Top-level client component for /customer/customer/[entityId].
 *
 * Fan-out on mount: three parallel fetches for the customer record, trend,
 * and action log. The comms thread is owned by V2CommsThreadPanel which
 * fetches its own (slower) Metabase data lazily.
 */
function V2CustomerDetailClient({ entityId }: Props) {
  const [customer, setCustomer] = useState<ScoredCustomerV2 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [actions, setActions] = useState<AmActionRow[]>([]);
  // Phase 33.B.8 — usage tracking
  const logEvent = useActivityLogger();

  // Phase 33.B.8 — log page_view per entity_id visited
  useEffect(() => {
    logEvent("page_view", {
      surface: "v2_customer_detail",
      entity_id: entityId,
    });
  }, [logEvent, entityId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function loadAll(): Promise<void> {
      try {
        const [custRes, trendRes, actionsRes] = await Promise.all([
          fetch(`/api/v2/customer/${encodeURIComponent(entityId)}`).then((r) =>
            r.json(),
          ),
          fetch(
            `/api/v2/customer/${encodeURIComponent(entityId)}/trend?days=90`,
          ).then((r) => r.json()),
          fetch(
            `/api/v2/customer/${encodeURIComponent(entityId)}/actions`,
          ).then((r) => r.json()),
        ]);

        if (cancelled) return;

        if (!custRes.ok || !custRes.customer) {
          setError(custRes.error || "Customer not found");
          setCustomer(null);
        } else {
          setCustomer(custRes.customer as ScoredCustomerV2);
        }

        const trendPoints = Array.isArray(trendRes?.points)
          ? trendRes.points.map(
              (p: { date: string; composite: number }) => ({
                date: p.date,
                composite: Number(p.composite || 0),
              }),
            )
          : [];
        setTrend(trendPoints);

        const actionRows = Array.isArray(actionsRes?.rows)
          ? (actionsRes.rows as AmActionRow[])
          : [];
        setActions(actionRows);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadAll();
    return () => {
      cancelled = true;
    };
  }, [entityId]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 md:px-6 md:py-8">
      <Breadcrumb
        amName={customer?.am_name || ""}
        company={customer?.company || ""}
        locationRecordId={(customer?.hubspot as any)?.hubspot_location_record_id}
      />

      {error && !loading && (
        <div className="mt-6 rounded-zoca-lg border border-zoca-pink/60 bg-zoca-pink-soft p-6 text-center">
          <div className="text-[14px] font-semibold text-zoca-pink-bright">
            Couldn’t load customer detail
          </div>
          <div className="mt-1 text-[12px] text-zoca-pink-bright/80">{error}</div>
          <a
            href="/customer"
            className="mt-3 inline-flex items-center gap-1 rounded-zoca-pill border border-rose-300 bg-zoca-bg-soft px-3 py-1 text-[12px] font-medium text-zoca-pink-bright hover:bg-zoca-pink-soft"
          >
            ← Back to dashboard
          </a>
        </div>
      )}

      {loading && <LoadingSkeleton />}

      {!loading && !error && customer && (
        <>
          <V2DetailHeader customer={customer} trend={trend} />

          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <V2ActionLogPanel actions={actions} />
              <V2NotesPanel
                amName={customer.am_name}
                entityId={customer.entity_id}
                customerId={customer.customer_id || null}
                bizname={customer.company || null}
              />
              <V2BillingPanel customer={customer} />
              <V2TicketsPanel customer={customer} />
            </div>
            <div className="space-y-4">
              <PerformanceCard customer={customer} />
              <V2HubspotPanel customer={customer} />
              <V2CommsThreadPanel entityId={customer.entity_id} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Breadcrumb({ amName, company, locationRecordId }: { amName: string; company: string; locationRecordId?: string }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-baseline gap-1 text-[12px] text-zoca-text-2"
    >
      <a
        href="/customer"
        className="inline-flex items-center gap-1 rounded-zoca-pill px-2 py-0.5 hover:bg-zoca-bg-tint hover:text-zoca-text"
      >
        ← Back to dashboard
      </a>
      {amName && (
        <>
          <span aria-hidden>/</span>
          <a
            href={`/customer?am=${encodeURIComponent(amName)}`}
            className="rounded-zoca-pill px-2 py-0.5 hover:bg-zoca-bg-tint hover:text-zoca-text"
          >
            {amName}
          </a>
        </>
      )}
      {company && (
        <>
          <span aria-hidden>/</span>
          {locationRecordId ? (
            <a
              href={`https://app-na2.hubspot.com/contacts/243752563/record/2-221793621/${locationRecordId}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${company} in HubSpot Locations (new tab)`}
              className="rounded-zoca-pill px-2 py-0.5 font-medium text-zoca-text hover:bg-zoca-bg-tint hover:text-zoca-pink-cta"
            >
              {company} ↗
            </a>
          ) : (
            <span className="px-2 py-0.5 font-medium text-zoca-text">
              {company}
            </span>
          )}
        </>
      )}
    </nav>
  );
}

function LoadingSkeleton() {
  return (
    <div className="mt-6 space-y-4" aria-busy="true" aria-live="polite">
      <div className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-5 md:p-6">
        <div className="h-6 w-1/3 animate-pulse rounded-zoca-pill bg-zoca-bg-tint" />
        <div className="mt-3 h-4 w-1/4 animate-pulse rounded-zoca-pill bg-zoca-bg-tint" />
        <div className="mt-4 h-12 w-full animate-pulse rounded-zoca bg-zoca-bg-tint" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5"
          >
            <div className="h-4 w-1/3 animate-pulse rounded-zoca-pill bg-zoca-bg-tint" />
            <div className="mt-3 space-y-2">
              <div className="h-3 w-full animate-pulse rounded-zoca-pill bg-zoca-bg-tint" />
              <div className="h-3 w-5/6 animate-pulse rounded-zoca-pill bg-zoca-bg-tint" />
              <div className="h-3 w-2/3 animate-pulse rounded-zoca-pill bg-zoca-bg-tint" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PerformanceCard({ customer }: { customer: ScoredCustomerV2 }) {
  return (
    <section className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zoca-text-2">
          Performance signals
        </h3>
      </div>
      <V2PerformancePanel performance={customer.performance} tier={customer.signals_v2.stoplight} />
    </section>
  );
}

export default V2CustomerDetailClient;
