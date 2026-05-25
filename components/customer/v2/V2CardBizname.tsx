"use client";

/**
 * V2CardBizname — Phase E-15.6 extraction.
 *
 * Two HubSpot-linked subcomponents from V2CustomerCard:
 *
 *   BiznameLink     — wraps bizname text in an anchor when a HubSpot Locations
 *                     record id is known; renders children plainly otherwise.
 *
 *   ContactsSection — renders the top-5 HubSpot contacts inside the "Why?"
 *                     expand. Each row is a name + job_title + clickable
 *                     email + last-activity stamp.
 *
 * Both are stateless and presentation-only. Lifting them removes ~110 lines
 * from V2CustomerCard. They also share a small `daysSince` helper that we
 * re-export from a util so V2CustomerCard can keep importing it locally.
 */

import * as React from "react";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import {
  buildMailto,
  buildHubspotLocationUrl,
} from "@/lib/customer/contact-links";

/** Days between an ISO timestamp and now, floored to whole days. */
export function daysSince(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400_000));
}

// ---------------------------------------------------------------------------
// BiznameLink (Phase 20)
// ---------------------------------------------------------------------------

type BiznameLinkProps = {
  bizname: string;
  /** Phase 33.D — HubSpot Locations record id (replaces hubspotCompanyId). */
  hubspotLocationRecordId?: string;
  children: React.ReactNode;
};

export function BiznameLink({
  bizname,
  hubspotLocationRecordId,
  children,
}: BiznameLinkProps) {
  if (!hubspotLocationRecordId) {
    return <>{children}</>;
  }
  return (
    <a
      href={buildHubspotLocationUrl(hubspotLocationRecordId)}
      target="_blank"
      rel="noopener noreferrer"
      className="group/biz inline-flex items-baseline gap-1"
      style={{
        color: "inherit",
        textDecoration: "none",
        cursor: "pointer",
      }}
      title={`Open ${bizname} in HubSpot Locations (new tab)`}
    >
      {children}
      <i
        className="ti ti-external-link opacity-0 transition-opacity group-hover/biz:opacity-100"
        aria-hidden
        style={{ fontSize: "12px", lineHeight: 1, color: "var(--zoca-text-3, #94a3b8)" }}
      />
    </a>
  );
}

// ---------------------------------------------------------------------------
// CONTACTS section (Phase 14C — Tier E: buyer-side org chart)
//
// Top-5 HubSpot contacts inside the "Why?" expand. Styling matches the
// PERFORMANCE SIGNALS section in V2PerformancePanel.
// ---------------------------------------------------------------------------

type ContactsSectionProps = {
  contacts: NonNullable<NonNullable<ScoredCustomerV2["hubspot"]>["contacts"]>;
  /** Phase 20 — passed through so mailto: subject/body can be pre-filled. */
  bizname?: string;
  amName?: string;
};

export function ContactsSection({ contacts, bizname, amName }: ContactsSectionProps) {
  if (!contacts || contacts.length === 0) return null;
  return (
    <div className="mt-3 rounded-zoca-sm border border-zoca-border bg-zoca-surface-soft/40 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-zoca-text-2">
        Contacts
      </div>
      <ul className="space-y-1.5">
        {contacts.slice(0, 5).map((c) => {
          const sinceLabel = c.last_activity ? `${daysSince(c.last_activity)}d ago` : "—";
          return (
            <li
              key={c.contact_id}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[11px]"
            >
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-zoca-text">{c.name}</span>
                {c.job_title && (
                  <span className="text-[10px] text-zoca-text-2">{c.job_title}</span>
                )}
              </span>
              <span className="flex flex-wrap items-baseline gap-x-2">
                {c.email ? (
                  <a
                    href={buildMailto(c.email, { bizname, amName })}
                    className="inline-flex items-center gap-1 hover:underline"
                    style={{ color: "var(--zoca-blue, #2563eb)", textDecoration: "none" }}
                    title={`Email ${c.name} — opens your mail client with a pre-filled draft`}
                  >
                    <i className="ti ti-mail" aria-hidden style={{ fontSize: "11px", lineHeight: 1 }} />
                    {c.email}
                  </a>
                ) : (
                  <span className="text-zoca-text-2">—</span>
                )}
                <span className="text-[10px] text-zoca-text-2" title={c.last_activity || ""}>
                  {sinceLabel}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
