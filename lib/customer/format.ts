/**
 * Phase 17.A / Phase 33.brand-watchfire-T12 — produce personalized hero title.
 * The hero h1 now reads "{First Name}'s Beacon" (or "{First Name}'s Monday Beacon"
 * on Mondays) to match the heraldic brand register. Was "...planner".
 *
 * Examples:
 *   "Sudha's Monday Beacon"   (Monday + first name available)
 *   "Sudha's Beacon"          (other day + first name)
 *   "AM's Beacon"             (no name)
 */
export function formatPlannerTitle(amName: string | null | undefined, now: Date = new Date()): string {
  const firstName = (amName || "").trim().split(/\s+/)[0];
  const day = now.toLocaleDateString("en-US", { weekday: "long" });
  const subject = firstName || "AM";
  const dayPrefix = day === "Monday" ? "Monday " : "";
  return `${subject}'s ${dayPrefix}Beacon`;
}

/**
 * Phase 17.D / Phase 33.brand-watchfire-T12 — manager hero h1.
 * Returns "Manager's Beacon" so both surfaces (AM + Manager) share the
 * same noun. The nav tabs ("AM's view" / "Manager's view") stay as is —
 * they label the route, not the page.
 */
export function formatManagerTitle(): string {
  return "Manager's Beacon";
}
