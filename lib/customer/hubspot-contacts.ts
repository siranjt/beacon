/**
 * Fetch top contacts per HubSpot company (Phase 14C — Tier E).
 *
 * For every company, returns up to 5 contacts sorted by last-activity
 * (descending). The CONTACTS section in the V2 customer card uses this
 * to surface the buyer-side org chart — who the AM should reach out to
 * when the primary contact has gone dark.
 *
 * Pattern mirrors lib/hubspot-deals.ts / lib/hubspot-calls.ts:
 *   associations -> batch read -> per-company aggregation.
 *
 * Fails gracefully: if HubSpot isn't configured or contacts can't be
 * read, returns an empty Map. Stage D continues.
 */

import { hubspotBatchRead, hubspotBatchAssociations, hubspotConfigured } from "./hubspot";

export type CompanyContact = {
  contact_id: string;
  name: string;
  email: string | null;
  job_title: string | null;
  last_activity: string | null;
};

const CONTACT_PROPS = [
  "firstname",
  "lastname",
  "email",
  "jobtitle",
  "lastmodifieddate",
  "notes_last_contacted",
];
const MAX_CONTACTS_PER_COMPANY = 5;

type HubspotApiContact = {
  id: string;
  properties: Record<string, string>;
};

export async function fetchContactsForCompanies(
  hubspotCompanyIds: string[],
): Promise<Map<string, CompanyContact[]>> {
  const out = new Map<string, CompanyContact[]>();
  if (!hubspotConfigured() || !hubspotCompanyIds.length) return out;

  // 1) company -> contact_ids
  let companyToContactIds: Map<string, number[]>;
  try {
    companyToContactIds = await hubspotBatchAssociations(
      "companies",
      hubspotCompanyIds,
      "contacts",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[hubspot-contacts] associations error (skipping): ${msg}`);
    return out;
  }
  console.log(
    `[hubspot-contacts] companies with contacts: ${companyToContactIds.size}/${hubspotCompanyIds.length}`,
  );
  if (companyToContactIds.size === 0) return out;

  // 2) collect unique contact ids
  const allContactIds = new Set<number>();
  for (const ids of companyToContactIds.values()) {
    for (const id of ids) allContactIds.add(id);
  }
  console.log(
    `[hubspot-contacts] unique contact IDs to fetch: ${allContactIds.size}`,
  );
  if (allContactIds.size === 0) return out;

  // 3) batch read (auto-chunks at 100)
  const contactRecords = new Map<string, HubspotApiContact>();
  const arr = Array.from(allContactIds);
  let fetched: HubspotApiContact[] = [];
  try {
    fetched = await hubspotBatchRead<HubspotApiContact>("contacts", arr, CONTACT_PROPS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[hubspot-contacts] batch read error (skipping): ${msg}`);
    return out;
  }
  for (const c of fetched) contactRecords.set(c.id, c);

  // 4) per company, take top 5 by last activity (desc)
  for (const [companyId, contactIds] of companyToContactIds) {
    const contacts: CompanyContact[] = [];
    for (const cid of contactIds) {
      const c = contactRecords.get(String(cid));
      if (!c) continue;
      const p = c.properties || {};
      const fn = (p.firstname || "").trim();
      const ln = (p.lastname || "").trim();
      const name = `${fn} ${ln}`.trim() || (p.email || "").trim() || "—";
      contacts.push({
        contact_id: c.id,
        name,
        email: p.email || null,
        job_title: p.jobtitle || null,
        last_activity: p.notes_last_contacted || p.lastmodifieddate || null,
      });
    }
    contacts.sort((a, b) => {
      const am = a.last_activity ? Date.parse(a.last_activity) : 0;
      const bm = b.last_activity ? Date.parse(b.last_activity) : 0;
      return bm - am;
    });
    if (contacts.length > 0) {
      out.set(companyId, contacts.slice(0, MAX_CONTACTS_PER_COMPANY));
    }
  }

  console.log(
    `[hubspot-contacts] fetched contacts for ${out.size}/${hubspotCompanyIds.length} companies (${contactRecords.size} contact records)`,
  );
  return out;
}
