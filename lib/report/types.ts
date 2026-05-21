/**
 * Type model for the Zoca per-customer performance report.
 *
 * Mirrors the 10 sections of the reference report (888 F&N, April 2026):
 *   1. Header (identity)
 *   2. Performance Snapshot — 4 tiles
 *   3. Lead-source callout banner
 *   4. GBP Profile Clicks Journey
 *   5. Top Keyword Rankings
 *   6. Leads Analysis
 *   7. RCA — click dip + Linear ticket
 *   8. Action Checklist (signals + library)
 *   9. 6-Month Forecast — 3 tiles
 *  10. Growth Manager Note
 */

// -- Identity -----------------------------------------------------------------

export type Vertical =
  | "spa_massage"
  | "hair_salon"
  | "nail_salon"
  | "med_spa"
  | "beauty_specialty"
  | "barber"
  | "tanning"
  | "default";

export type LocationIdentity = {
  entityId: string;
  /** `locations/<google_id>` — joins to gbp.metrics.location_name */
  locationName: string;
  title: string;
  /** Raw Google primary-category display name, e.g. "Massage spa" */
  verticalDisplay: string | null;
  /** Canonicalized to one of our playbooks. */
  vertical: Vertical;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  websiteUri: string | null;
  placeId: string | null;
  mapsUri: string | null;
  status: "OPEN" | "CLOSED" | "OPEN_FOR_BUSINESS" | string | null;
  /** When the location row was first ingested by Zoca. */
  locationCreatedAt: string | null;
};

// -- GBP clicks trend ---------------------------------------------------------

export type GbpMonthlyClicks = {
  /** First day of month, ISO date. */
  month: string;
  /** Sum of all 6 click types. */
  profileClicks: number;
  bookings: number;
  directionRequests: number;
  callClicks: number;
};

// -- Keyword rankings ---------------------------------------------------------

export type KeywordRanking = {
  keyword: string;
  /** First observed rank after onboarding. May be null if no early data. */
  rankWhenJoined: number | null;
  /** Best (lowest) rank ever observed. */
  rankBest: number | null;
  /** Most recent rank. */
  rankCurrent: number | null;
};

// -- Leads --------------------------------------------------------------------

export type LeadStatus =
  | "BOOKED"
  | "CONTACTED"
  | "UNMARKED"
  | "NOT_INTERESTED"
  | "FOLLOW_UP"
  | string;

export type LeadCustomerType = "new" | "returning" | "" | null;

export type Lead = {
  id: string;
  createdAt: string;
  status: LeadStatus;
  source: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  /** True if utm chain attributes the lead to GBP (Google Maps). */
  isGbpSourced: boolean;
  service: string | null;
  serviceVariationName: string | null;
  price: number | null;
  currency: string | null;
  customerType: LeadCustomerType;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  /** First message of the conversation_summary jsonb, if present. */
  firstMessage: string | null;
  bookingId: string | null;
  isLeadToBookingActive: boolean;
};

// -- Forecast -----------------------------------------------------------------

export type Forecast = {
  entityId: string;
  generatedAt: string;
  predicted6MonthRevenue: number | null;
  predicted6MonthLeads: number | null;
  /** Weekly review-acquisition target. */
  reviewTarget: number | null;
  percentageChangeProfileClicks: number | null;
  withZoca6MonthProfileClicks: number | null;
  withoutZoca6MonthProfileClicks: number | null;
  gbpScore: number | null;
  websiteScore: number | null;
  /** Raw audit blob — used by the signal engine. */
  gbpAudit: unknown;
  /** Raw monthly breakdown — used for forecast detail rendering. */
  monthlyPredictions: unknown;
  metadata: unknown;
};

// -- Composite shapes ---------------------------------------------------------

/**
 * The complete data bundle for one entity, with fetchers populating each
 * field. Renderers consume this; signal engine reads from it.
 */
export type EntityReportData = {
  identity: LocationIdentity;
  gbpClicks: GbpMonthlyClicks[];
  keywords: KeywordRanking[];
  leads: Lead[];
  forecast: Forecast | null;
  fetchedAt: string;
};
