/**
 * V2AMTriageFilters — Phase E-15.4c extraction.
 *
 * Filter + sort discriminated unions, their key tables, and the type guards
 * used to validate URL query params and saved-view payloads. Pure types +
 * functions — no React, no runtime dependencies. Lifting them out is purely
 * file-size hygiene; V2AMTriage imports them back unchanged.
 *
 * Phase 32.1 — added "watch" (YELLOW) + "healthy" (GREEN) so primary filter
 * pills mirror the KPI tile tiers exactly. "improving" and "quiet" remain in
 * the type for URL backward-compat + saved views but no longer have primary
 * chips on the bar.
 */

export type FilterKey =
  | "pinned"
  | "act"
  | "watch"
  | "healthy"
  | "improving"
  | "quiet"
  | "all"
  | "snoozed";

export type SortKey = "urgency" | "plan" | "lasttouch";

export const FILTER_KEYS: FilterKey[] = [
  "pinned",
  "act",
  "watch",
  "healthy",
  "improving",
  "quiet",
  "all",
  "snoozed",
];

export const SORT_KEYS: SortKey[] = ["urgency", "plan", "lasttouch"];

export function isFilterKey(v: string): v is FilterKey {
  return (FILTER_KEYS as string[]).includes(v);
}

export function isSortKey(v: string): v is SortKey {
  return (SORT_KEYS as string[]).includes(v);
}

export const ACT_TODAY_TOP_N = 10;
