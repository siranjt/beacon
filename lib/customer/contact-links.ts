/**
 * Phase 20 → 33.D — One-click contact launchers.
 *
 * Pure URL builders used by V2CustomerCard (and potentially other surfaces
 * later) to turn email / phone / HubSpot company references into clickable
 * `mailto:` / `tel:` / `https://app.hubspot.com/...` links.
 *
 * Phase 33.D adds buildHubspotLocationUrl — points at the Zoca Locations
 * custom object (objectTypeId 2-221793621) on the NA2 portal. The legacy
 * buildHubspotCompanyUrl stays for backward compatibility; new code should
 * prefer buildHubspotLocationUrl with the location_record_id resolved from
 * hubspot_location_mapping.
 *
 * No I/O, no state — these are pure functions of their inputs.
 */

import { buildHubspotLocationUrl as _buildHubspotLocationUrl } from "@/lib/customer/hubspot-config";

/**
 * Build a mailto: URL pre-filled with a friendly subject + body using the
 * customer's bizname and the AM's name. Falls back to a generic subject if
 * either is missing.
 */
export function buildMailto(
  email: string,
  opts: { bizname?: string; amName?: string } = {},
): string {
  const subject =
    opts.bizname && opts.amName
      ? `${opts.bizname} — quick check-in from ${opts.amName}`
      : "Quick check-in";
  const body =
    opts.bizname && opts.amName
      ? `Hi,\n\nFollowing up on ${opts.bizname}. Wanted to touch base — when's a good time for a quick call?\n\nThanks,\n${opts.amName}`
      : "";
  const qs = new URLSearchParams({ subject, body }).toString();
  return `mailto:${email}?${qs}`;
}

/**
 * Strip whitespace and non-digit characters from a phone number, preserving
 * a leading "+", and return a `tel:` URL.
 */
export function buildTelLink(phone: string): string {
  const cleaned = phone.replace(/[^\d+]/g, "");
  return `tel:${cleaned}`;
}

/**
 * @deprecated Phase 33.D — Use buildHubspotLocationUrl instead.
 * Build a HubSpot company-page URL for the given company id. Kept for any
 * legacy call sites that haven't been migrated to the Locations custom object.
 */
export function buildHubspotCompanyUrl(companyId: string): string {
  const portal = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID || "";
  if (!portal) {
    return `https://app.hubspot.com/contacts/?id=${companyId}`;
  }
  return `https://app.hubspot.com/contacts/${portal}/company/${companyId}`;
}

/**
 * Phase 33.D — Build a HubSpot Locations record URL.
 * Re-exports the function from lib/hubspot-config.ts so existing imports
 * from contact-links.ts continue to work.
 */
export const buildHubspotLocationUrl = _buildHubspotLocationUrl;

/**
 * Phase 28 — Internal app URL for the per-customer detail page.
 * Use this anywhere you need to deep-link to /v2/customer/[entityId].
 */
export function buildCustomerDetailUrl(entityId: string): string {
  return `/v2/customer/${encodeURIComponent(entityId)}`;
}
