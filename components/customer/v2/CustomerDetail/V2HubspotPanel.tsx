"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (0 hex/rgba + 2 tailwind-rose swept)

import type { ScoredCustomerV2 } from "@/lib/customer/types";
import { buildMailto, buildHubspotLocationUrl } from "@/lib/customer/contact-links";

type Props = {
  customer: ScoredCustomerV2;
};

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400_000));
}

function V2HubspotPanel({ customer }: Props) {
  const contacts = customer.hubspot?.contacts ?? [];
  const lastCall = customer.hubspot?.last_call ?? null;
  const bizname = customer.company || undefined;
  const amName = customer.am_name || undefined;
  const locationRecordId = (customer.hubspot as any)?.hubspot_location_record_id as string | undefined;

  return (
    <div className="space-y-4">
      {/* Contacts */}
      <section
        className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5"
        aria-label="HubSpot contacts"
      >
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zoca-text-2">
            Contacts · {contacts.length}
          </h3>
          {locationRecordId && (
            <a
              href={buildHubspotLocationUrl(locationRecordId)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] font-medium text-zoca-pink-cta hover:underline"
              title="Open in HubSpot"
            >
              Open in HubSpot →
            </a>
          )}
        </div>
        {contacts.length === 0 ? (
          <div className="rounded-zoca border border-dashed border-zoca-border bg-zoca-bg-tint/40 px-3 py-2 text-[12px] text-zoca-text-2">
            No HubSpot contacts mapped.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {contacts.slice(0, 5).map((c) => {
              const since = daysSince(c.last_activity);
              return (
                <li
                  key={c.contact_id}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[12px]"
                >
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-zoca-text">{c.name}</span>
                    {c.job_title && (
                      <span className="text-[11px] text-zoca-text-2">
                        {c.job_title}
                      </span>
                    )}
                  </span>
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    {c.email ? (
                      <a
                        href={buildMailto(c.email, { bizname, amName })}
                        className="inline-flex items-center gap-1 text-zoca-pink-cta hover:underline"
                        title={`Email ${c.name}`}
                      >
                        <i
                          className="ti ti-mail"
                          aria-hidden
                          style={{ fontSize: "11px", lineHeight: 1 }}
                        />
                        {c.email}
                      </a>
                    ) : (
                      <span className="text-zoca-text-2">—</span>
                    )}
                    <span
                      className="text-[10px] text-zoca-text-2 tabular-nums"
                      title={c.last_activity || ""}
                    >
                      {since !== null ? `${since}d ago` : "—"}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Last call */}
      <section
        className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5"
        aria-label="Last HubSpot call"
      >
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zoca-text-2">
            Last call
          </h3>
        </div>
        {!lastCall ? (
          <div className="rounded-zoca border border-dashed border-zoca-border bg-zoca-bg-tint/40 px-3 py-2 text-[12px] text-zoca-text-2">
            No HubSpot calls logged in the last 90 days.
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-zoca-text-2">
              <span title={lastCall.date}>
                {(() => {
                  const d = daysSince(lastCall.date);
                  return d !== null ? `${d}d ago` : lastCall.date;
                })()}
              </span>
              <span
                className={`rounded-zoca-pill px-1.5 py-0.5 text-[10px] font-medium ${
                  lastCall.sentiment === "frustrated"
                    ? "bg-zoca-pink/18 text-zoca-pink-bright"
                    : lastCall.sentiment === "warm"
                      ? "bg-emerald-500/18 text-emerald-700"
                      : "bg-zoca-bg-tint text-zoca-text-2"
                }`}
              >
                {lastCall.sentiment === "frustrated"
                  ? "😟 frustrated"
                  : lastCall.sentiment === "warm"
                    ? "😊 warm"
                    : "— neutral"}
              </span>
              {lastCall.topics.length > 0 && (
                <span title="Topics extracted from the meeting note">
                  · topics:{" "}
                  <span className="text-zoca-text">
                    {lastCall.topics.join(", ")}
                  </span>
                </span>
              )}
              {lastCall.fireflies_url && (
                <a
                  href={lastCall.fireflies_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto text-zoca-pink-cta hover:underline"
                >
                  Fireflies →
                </a>
              )}
            </div>
            {lastCall.action_items.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-zoca-text-2">
                {lastCall.action_items.slice(0, 5).map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export default V2HubspotPanel;
