// Phase 33.A — email → AM name resolver.
//
// Called from the NextAuth `jwt` callback the first time a user signs in.
// Two strategies, tried in order:
//
//   1. Exact match on BaseSheet's `app_email` column → return that row's
//      `am_name`. The BaseSheet is the master mapping between Chargebee
//      handles, entity IDs, and AM ownership — same source the rest of the
//      dashboard reads from.
//
//   2. Fallback heuristic: split the local-part of the email on common
//      separators ("first.last", "first_last", "firstlast") and case-
//      insensitively match against ACTIVE_AMS. This covers the AMs who
//      don't appear in `app_email` (which is the customer's email, not the
//      AM's) but whose Google account follows the firstname.lastname pattern.
//
// If neither resolves → return null. The admin role still works without an
// AM mapping; AM-role users without a mapping see an empty-state on the
// dashboard ("contact your manager").
//
// Soft-fail: this function NEVER throws. If the BaseSheet fetch fails we log
// + return null, and the session is still issued (the user just won't have
// a pre-filled AM name — admins can re-fetch later).

import { fetchBaseSheet } from "@/lib/customer/metabase";
import { ACTIVE_AMS } from "@/lib/customer/config";
import type { BaseSheetRow } from "@/lib/customer/types";

type Cache = { rows: BaseSheetRow[]; ts: number };

let _cache: Cache | null = null;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

async function loadBaseSheetRows(): Promise<BaseSheetRow[]> {
  const now = Date.now();
  if (_cache && now - _cache.ts < TTL_MS) {
    return _cache.rows;
  }
  try {
    const { rows } = await fetchBaseSheet();
    _cache = { rows, ts: now };
    return rows;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[auth-mapping] BaseSheet fetch failed: ${msg}`);
    // If we have a stale cache, prefer that over null
    if (_cache) return _cache.rows;
    return [];
  }
}

/**
 * Heuristic: parse the local-part of an email and try to match against
 * ACTIVE_AMS by case-insensitive comparison of the candidate name forms.
 * Returns the canonical AM name (matching ACTIVE_AMS) on success.
 */
function matchAmByEmailLocalPart(email: string): string | null {
  const localPart = email.split("@")[0] || "";
  if (!localPart) return null;
  // Generate candidate name strings:
  //   - "first.last"  → "first last"
  //   - "first_last"  → "first last"
  //   - "first-last"  → "first last"
  //   - "firstlast"   → "firstlast"
  // We also lowercase + strip whitespace for the actual comparison.
  const candidates = new Set<string>();
  const lower = localPart.toLowerCase();
  candidates.add(lower);
  candidates.add(lower.replace(/[._\-]+/g, " "));
  candidates.add(lower.replace(/[._\-]+/g, ""));
  // Also try last-name-only (e.g. "shetty@zoca.ai" → "Siddhi Shetty")
  const parts = lower.split(/[._\-]+/).filter(Boolean);
  if (parts.length > 0) {
    candidates.add(parts[parts.length - 1]);
    candidates.add(parts[0]);
  }

  for (const am of ACTIVE_AMS) {
    const amLower = am.toLowerCase();
    const amCollapsed = amLower.replace(/\s+/g, "");
    if (candidates.has(amLower) || candidates.has(amCollapsed)) {
      return am;
    }
    // Also try first-name-only or last-name-only token match — guards
    // against single-token email locals ("apurvaa@zoca.ai" → "Apurvaa Biswas").
    const amTokens = amLower.split(/\s+/).filter(Boolean);
    for (const tok of amTokens) {
      if (candidates.has(tok)) return am;
    }
  }
  return null;
}

/**
 * Resolve an authenticated Zoca user's email to their canonical AM name.
 * Never throws. Returns null if no mapping can be established.
 */
export async function resolveAmNameForEmail(
  email: string,
): Promise<string | null> {
  try {
    const normalized = (email || "").trim().toLowerCase();
    if (!normalized) return null;

    const rows = await loadBaseSheetRows();
    // Strategy 1: BaseSheet app_email exact match
    for (const r of rows) {
      const rowEmail = (r.app_email || "").trim().toLowerCase();
      if (rowEmail && rowEmail === normalized) {
        const am = (r.am_name || "").trim();
        if (am) return am;
      }
    }

    // Strategy 2: parse the local-part and match ACTIVE_AMS
    const fromLocal = matchAmByEmailLocalPart(normalized);
    if (fromLocal) return fromLocal;

    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[auth-mapping] resolveAmNameForEmail threw: ${msg}`);
    return null;
  }
}
