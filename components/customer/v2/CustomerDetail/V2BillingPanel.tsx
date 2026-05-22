"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (0 hex/rgba + 3 tailwind-rose swept)

import type { ScoredCustomerV2 } from "@/lib/customer/types";

type Props = {
  customer: ScoredCustomerV2;
};

function V2BillingPanel({ customer }: Props) {
  const b = customer.billing;
  const unpaidCount = b?.unpaid_invoice_count ?? 0;
  const totalDueCents = b?.total_amount_due_cents ?? 0;
  const totalDueDollars = totalDueCents / 100;
  const daysOverdue = b?.days_past_oldest_unpaid ?? 0;
  const achInProgress = !!b?.has_ach_in_progress;
  const planText =
    customer.plan_amount > 0
      ? `$${customer.plan_amount.toLocaleString()}/mo`
      : "—";

  const chargebeeUrl = customer.customer_id
    ? `https://zoca.chargebee.com/d/customers/${encodeURIComponent(customer.customer_id)}`
    : null;

  return (
    <section
      className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5"
      aria-label="Billing"
    >
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zoca-text-2">
          Billing
        </h3>
        {chargebeeUrl && (
          <a
            href={chargebeeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] font-medium text-zoca-pink-cta hover:underline"
            title="Open this customer in Chargebee"
          >
            Open in Chargebee →
          </a>
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zoca-text-2">
            Plan
          </div>
          <div className="text-[20px] font-semibold tabular-nums text-zoca-text">
            {planText}
          </div>
        </div>
        {customer.auto_collection && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zoca-text-2">
              Auto-collection
            </div>
            <div className="text-[12px] font-medium text-zoca-text capitalize">
              {customer.auto_collection.replace(/_/g, " ")}
            </div>
          </div>
        )}
      </div>

      <div className="mt-4">
        <div className="text-[10px] uppercase tracking-wider text-zoca-text-2">
          Unpaid invoices
        </div>
        {unpaidCount > 0 ? (
          <div className="mt-1 text-[12.5px] leading-relaxed">
            <span className="font-semibold text-zoca-pink-bright tabular-nums">
              {unpaidCount} unpaid
            </span>{" "}
            <span className="text-zoca-text-2">·</span>{" "}
            <span className="font-semibold text-zoca-pink-bright tabular-nums">
              ${totalDueDollars.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>{" "}
            <span className="text-zoca-text-2">overdue</span>
            {daysOverdue > 0 && (
              <>
                {" "}
                <span className="text-zoca-text-2">·</span>{" "}
                <span className="font-semibold text-zoca-pink-bright tabular-nums">
                  {daysOverdue}d
                </span>{" "}
                <span className="text-zoca-text-2">past due</span>
              </>
            )}
            {achInProgress && (
              <span className="ml-2 rounded-zoca-pill bg-sky-500/14 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                ⏳ ACH in progress
              </span>
            )}
          </div>
        ) : (
          <div className="mt-1 text-[12.5px] text-zoca-text-2">All paid.</div>
        )}
      </div>
    </section>
  );
}

export default V2BillingPanel;
