/**
 * Command palette search + scoring. Phase E-9.
 *
 * Inputs are customer records; output is a sorted list of matches with a
 * numeric score. We use a hand-rolled weighted match instead of pulling in
 * Fuse.js so:
 *   1. Bundle stays small (no extra 8 KB dep)
 *   2. We control the weighting (bizname > entity_id > AM > email)
 *   3. UUID prefix matches always win — "a24bb" should jump straight to
 *      the customer with that entity_id even if "Anuradha" is closer in
 *      Levenshtein distance.
 *
 * Scoring tiers (higher = better):
 *   1000  exact bizname (case-insensitive)
 *    900  bizname starts with query
 *    800  entity_id starts with query (UUID prefix lookup)
 *    700  cb_customer_id starts with query
 *    500  bizname contains query (word boundary preferred)
 *    300  am_name contains query
 *    200  email contains query
 *    100  any other substring match
 *      0  no match
 *
 * Ties broken by bizname alphabetic ascending.
 */

export interface SearchableCustomer {
  entity_id: string;
  biz_name: string;
  am_name: string | null;
  cb_customer_id: string;
  email: string | null;
}

export interface ScoredMatch {
  customer: SearchableCustomer;
  score: number;
}

function safeLower(s: string | null | undefined): string {
  return (s || "").toLowerCase().trim();
}

/**
 * Score a single customer against a query. Returns 0 when nothing matches —
 * caller filters out zero-score rows.
 */
export function scoreMatch(customer: SearchableCustomer, query: string): number {
  const q = safeLower(query);
  if (!q) return 0;

  const biz = safeLower(customer.biz_name);
  const eid = safeLower(customer.entity_id);
  const cid = safeLower(customer.cb_customer_id);
  const am = safeLower(customer.am_name);
  const email = safeLower(customer.email);

  if (biz === q) return 1000;
  if (biz.startsWith(q)) return 900;
  if (eid.startsWith(q)) return 800;
  if (cid.startsWith(q)) return 700;

  // Word-boundary bizname match — "spa" matches "Skin Spa" but ranks lower
  // than a prefix match.
  if (biz.includes(q)) {
    // Word-boundary substring → slight boost over mid-word substring.
    const isWordBoundary = new RegExp(`(^|\\s)${escapeRegex(q)}`).test(biz);
    return isWordBoundary ? 550 : 500;
  }

  if (am.includes(q)) return 300;
  if (email.includes(q)) return 200;

  // Final fallback — UUID anywhere or Chargebee handle anywhere.
  if (eid.includes(q)) return 150;
  if (cid.includes(q)) return 100;

  return 0;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Filter + score + sort a customer list against a query. Returns top N by
 * score, ties broken alphabetically by bizname.
 */
export function searchCustomers(
  customers: SearchableCustomer[],
  query: string,
  limit: number = 25,
): ScoredMatch[] {
  if (!query.trim()) return [];

  const scored: ScoredMatch[] = [];
  for (const c of customers) {
    const score = scoreMatch(c, query);
    if (score > 0) scored.push({ customer: c, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return safeLower(a.customer.biz_name).localeCompare(safeLower(b.customer.biz_name));
  });

  return scored.slice(0, limit);
}

/**
 * Short entity ID for display ("4f31a2c1…").
 */
export function shortEntity(entity_id: string): string {
  if (!entity_id) return "";
  return entity_id.length > 12 ? `${entity_id.slice(0, 8)}…` : entity_id;
}
