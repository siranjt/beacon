/**
 * Negative Keyword Beacon — BaseSheet enrichment. Phase NK-2.6.
 *
 * Joins each detected alert to its business identity:
 *   - business_name      ← BaseSheet.bizname
 *   - customer_id        ← BaseSheet.customer_id (Chargebee handle)
 *   - am_name            ← BaseSheet.am_name (may be empty for orphans)
 *   - owning_am_email    ← AM-name → email lookup, or ORPHAN_OWNER_EMAIL
 *                          when am_name is blank or unmappable
 *
 * Reuses the existing `lib/miss-payment/basesheet.ts` fetcher (10-min
 * cached) and the brain wave's `buildAmNameToEmail()` resolver, so we
 * don't duplicate BaseSheet plumbing or AM-name→email logic.
 *
 * The orphan fallback to siranjith.t@zoca.com is per Phase NK design
 * decision (2026-06-08) — entities without an AM mapping still need an
 * owner so they appear in someone's inbox.
 */

import {
  fetchBaseSheet,
  indexBaseSheet,
} from "@/lib/miss-payment/basesheet";
import { buildAmNameToEmail } from "@/lib/brain/extract-from-notes";
import { ORPHAN_OWNER_EMAIL } from "./types";

/** Per-entity identity facts looked up from BaseSheet + auth allowlists. */
export interface EntityIdentity {
  entity_id: string;
  business_name: string; // never empty — falls back to "Unknown business <eid8>"
  customer_id: string | null; // null when not mapped to Chargebee
  am_name: string | null; // null when BaseSheet has no am_name for this entity
  owning_am_email: string; // ORPHAN_OWNER_EMAIL when am_name unresolvable
}

/**
 * Build a lookup from entity_id → EntityIdentity for the full BaseSheet.
 * Single pass — caller iterates and looks up per-entity in O(1).
 *
 * Returns the lookup Map + the list of entity_ids present, so the cron
 * can iterate the canonical set rather than re-deriving it.
 */
export async function buildIdentityIndex(): Promise<{
  byEntityId: Map<string, EntityIdentity>;
  entityIds: string[];
}> {
  const rows = await fetchBaseSheet();
  const { byEntityId: rawIndex } = indexBaseSheet(rows);
  const amNameToEmail = await buildAmNameToEmail();

  const out = new Map<string, EntityIdentity>();
  const ids: string[] = [];

  for (const [entityId, row] of rawIndex.entries()) {
    if (!entityId) continue;
    const ident = mapRowToIdentity(entityId, row, amNameToEmail);
    out.set(entityId, ident);
    ids.push(entityId);
  }

  return { byEntityId: out, entityIds: ids };
}

/**
 * Pure mapper — exported for testability. Takes one BaseSheet row +
 * the AM-name→email lookup and produces the canonical NK identity.
 */
export function mapRowToIdentity(
  entityId: string,
  row: Record<string, unknown>,
  amNameToEmail: Map<string, string>,
): EntityIdentity {
  const business_name =
    pickString(row, "bizname") ||
    pickString(row, "business_name") ||
    `Unknown business ${entityId.slice(0, 8)}`;

  const customer_id = pickString(row, "customer_id") || null;
  const rawAmName = pickString(row, "am_name");
  const am_name = rawAmName || null;

  let owning_am_email = ORPHAN_OWNER_EMAIL;
  if (am_name) {
    const matched = amNameToEmail.get(am_name);
    if (matched) {
      owning_am_email = matched;
    }
    // If am_name exists in BaseSheet but isn't on any allowlist (e.g.
    // offboarded), we still route to ORPHAN_OWNER_EMAIL so the alert
    // surfaces somewhere. Worth noting in logs but not erroring.
  }

  return {
    entity_id: entityId,
    business_name,
    customer_id,
    am_name,
    owning_am_email,
  };
}

function pickString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v !== "string") return "";
  return v.trim();
}
