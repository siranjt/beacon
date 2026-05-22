"use client";

import * as React from "react";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import {
  groupTicketsByCategory,
  statusColor,
  type UnifiedTicket,
} from "@/lib/customer/tickets-unified";

type Props = {
  customer: ScoredCustomerV2;
};

function V2TicketsPanel({ customer }: Props) {
  const records: UnifiedTicket[] = customer.tickets?.records ?? [];
  const openCount = customer.tickets?.open_count ?? 0;
  const openStale = customer.tickets?.open_stale_count ?? 0;
  const closedRecent = customer.tickets?.closed_last_30d_count ?? 0;

  const grouped = React.useMemo(() => groupTicketsByCategory(records), [records]);

  return (
    <section
      id="tickets"
      className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5"
      aria-label="Tickets"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zoca-text-2">
          Tickets
        </h3>
        <span className="text-[11px] tabular-nums text-zoca-text-2">
          {openCount} open
          {" · "}
          <span
            className={openStale > 0 ? "font-medium text-amber-700" : undefined}
            title="Open tickets older than 7 days"
          >
            {openStale} stale &gt;7d
          </span>
          {" · "}
          {closedRecent} closed in last 30d
        </span>
      </div>

      {records.length === 0 ? (
        <div className="rounded-zoca border border-dashed border-zoca-border bg-zoca-bg-tint/40 px-3 py-2 text-[12px] text-zoca-text-2">
          No tickets in the last 30 days.
        </div>
      ) : (
        <div className="space-y-3">
          {Array.from(grouped.entries()).map(([category, items]) => {
            const openInCat = items.filter((t) => !t.is_closed).length;
            const defaultOpen = items.length <= 5;
            return (
              <details
                key={category}
                open={defaultOpen}
                className="group rounded-zoca border border-zoca-border bg-zoca-bg-soft"
              >
                <summary className="cursor-pointer list-none px-3 py-2 text-[12px] font-medium text-zoca-text marker:hidden">
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="inline-block transition-transform group-open:rotate-90"
                      aria-hidden
                    >
                      ▸
                    </span>
                    <span>{category}</span>
                    <span className="text-zoca-text-2">
                      · {openInCat} open
                      {items.length !== openInCat && (
                        <> · {items.length - openInCat} closed</>
                      )}
                    </span>
                  </span>
                </summary>
                <ul className="border-t border-zoca-border">
                  {items.map((t) => (
                    <TicketRow key={t.id} ticket={t} />
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      )}

      <div className="mt-3 text-[10px] text-zoca-text-2">
        Source: Metabase · refreshed nightly
      </div>
    </section>
  );
}

function TicketRow({ ticket: t }: { ticket: UnifiedTicket }) {
  const sc = statusColor(t.status);
  const closedClass = t.is_closed ? "opacity-60" : "";
  const titleClass = t.is_closed
    ? "line-through text-zoca-text-2"
    : "text-zoca-text";
  const lastTouched =
    t.days_since_update === null
      ? "—"
      : t.days_since_update === 0
        ? "today"
        : `${t.days_since_update}d ago`;

  return (
    <li
      className={`flex items-start gap-3 px-3 py-2.5 text-[12px] last:rounded-b-zoca odd:bg-zoca-bg-tint/30 ${closedClass}`}
    >
      <span
        className={`mt-0.5 inline-flex shrink-0 items-center rounded-zoca-pill px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${sc.bg} ${sc.fg}`}
        title={`Status: ${t.status_label}`}
      >
        {sc.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {t.url ? (
            <a
              href={t.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`break-words font-medium hover:underline ${titleClass}`}
              title={`Open ticket: ${t.title}`}
            >
              {t.title}
            </a>
          ) : (
            <span className={`break-words font-medium ${titleClass}`}>
              {t.title}
            </span>
          )}
          {t.is_stale && !t.is_closed && (
            <span
              className="rounded-zoca-pill bg-amber-500/14 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-700"
              title="Open for 7+ days without a resolution"
            >
              Stale
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-zoca-text-2 tabular-nums">
          <span>{t.status_label}</span>
          <span aria-hidden>·</span>
          <span title={t.assignee_email || undefined}>{t.assignee_name}</span>
          <span aria-hidden>·</span>
          <span title={t.created_at}>{t.age_days}d old</span>
          <span aria-hidden>·</span>
          <span title={t.last_updated_at || undefined}>
            last touched {lastTouched}
          </span>
        </div>
      </div>
      {t.url && (
        <a
          href={t.url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 self-center text-[11px] font-medium text-zoca-pink-cta hover:underline"
          title="Open ticket"
        >
          Open &nearr;
        </a>
      )}
    </li>
  );
}

export default V2TicketsPanel;
