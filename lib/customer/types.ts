import type { Tier, Stoplight, EngagementTier } from "./config";
import type { UnifiedTicket } from "./tickets-unified";

/** Raw Chargebee subscription (slimmed) */
export type ChargebeeSub = {
  subscription_id: string;
  customer_id: string;
  status: string;
  plan_amount: number;
  created_at: number | null;
  activated_at: number | null;
  /* lifecycle-state-types — Phase 33.scope */
  cancelled_at?: number | null;
  recently_cancelled?: boolean;
  auto_collection: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  phone: string | null;
};

// ---------------------------------------------------------------------------
// v2 — Chargebee invoices + transactions (for billing health signal)
// ---------------------------------------------------------------------------
export type ChargebeeInvoice = {
  invoice_id: string;
  customer_id: string;
  subscription_id: string | null;
  status: "payment_due" | "not_paid";
  amount_due: number;         // cents
  date: number;               // epoch seconds
  due_date: number | null;    // epoch seconds
  days_overdue: number;       // computed from due_date or date
};

export type ChargebeeTransaction = {
  id: string;
  customer_id: string;
  status: "in_progress" | "failure";
  amount: number;
  date: number;
  linked_invoice_ids: string[];
};

/** Per-entity billing rollup */
export type BillingMetrics = {
  entity_id: string;
  customer_id: string;
  unpaid_invoice_count: number;
  total_amount_due_cents: number;
  days_past_oldest_unpaid: number;
  has_ach_in_progress: boolean;
  auto_debit_off_with_failures: boolean;
  recent_failed_transaction_count: number;
};

/** Metabase BaseSheet row (slimmed — only the fields we use) */
export type BaseSheetRow = {
  entity_id: string;
  customer_id: string;
  bizname: string;
  am_name: string;
  ae_name: string;
  sp_name: string;
  app_email: string;
  phone_number: string;
  total_monthly_revenue: string;
  chrone_zoca_status: string;
  churn_potential_flag: string;
  churn_potential_status: string;
  ob_date: string;
  open_tickets_30d: string;
  unresolved_issues_last_30_days: string;
};

/** A single comms event */
export type CommsEvent = {
  entityId: string;
  ts: number;
  channel: "chat" | "email" | "phone" | "video" | "sms";
  direction: "in" | "out";
};

/** Per-window metrics */
export type CustomerMetrics = {
  total_7d: number;  in_7d: number;  out_7d: number;  channels_7d: number;
  total_14d: number; in_14d: number; out_14d: number; channels_14d: number;
  total_30d: number; in_30d: number; out_30d: number; channels_30d: number;
  total_60d: number; in_60d: number; out_60d: number; channels_60d: number;
  total_90d: number; in_90d: number; out_90d: number; channels_90d: number;
  channels_used_30d: string;
  channels_used_90d: string;
  last_any_iso: string | null;
  last_in_iso: string | null;
  last_out_iso: string | null;
  days_since_in: number;
  days_since_out: number;
};

/** v1 signals (kept for backward compat) */
export type CustomerSignals = {
  score: number;
  tier: Tier;
  sig_we_silent: number;
  sig_client_silent: number;
  sig_response_drop: number;
  sig_volume_collapse: number;
  notes: string;
};

// ---------------------------------------------------------------------------
// v2 — Product usage (Mixpanel-derived)
// ---------------------------------------------------------------------------

/** Per-event-type rollup for an entity */
export type MixpanelEventCount = {
  event_type: string;
  event_count: number;
  last_event_at: string;       // ISO
  days_since_last: number;
};

/** Per-entity usage rollup over 30/60/90 day windows */
export type UsageMetrics = {
  entity_id: string;
  total_events_7d: number;
  total_events_30d: number;
  total_events_90d: number;
  distinct_event_days_30d: number;        // # days in last 30 with ≥1 event
  distinct_app_open_days_30d: number;     // # days with App/Site Opened
  app_opens_30d: number;
  leads_engagement_30d: number;           // Leads-View-Home + Leads-Click-Lead
  leads_marked_30d: number;               // Leads-Select-LeadStatusSheet
  contact_attempts_30d: number;           // Leads-Click-LeadContact + ChatCall + DetailCopyNumber
  review_actions_30d: number;             // Reviews-* + Review-Click-SendInviteSingle
  last_event_at: string | null;
  days_since_last_event: number;
  engagement_tier: EngagementTier;
};

// ---------------------------------------------------------------------------
// v2 — Performance trajectory (Aurora-derived via Metabase cards)
// ---------------------------------------------------------------------------

/** Per-entity, per-month GBP profile-clicks row */
export type GbpClicksMonthRow = {
  entity_id: string;
  month_start: string;          // ISO date
  profile_clicks: number;
  last_day_in_month: string;
  is_complete_month: boolean;
};

/** Per-entity rankings aggregate */
export type RankingsRow = {
  entity_id: string;
  active_ranking_count: number;
  rankings_top_3: number;
  rankings_top_10: number;
  rankings_outside_10: number;
};

/** Per-entity reviews 12-week activity */
export type Reviews12wRow = {
  entity_id: string;
  reviews_last_12_weeks_total: number;
  weeks_with_zero_reviews: number;
};

/** Per-entity latest location_insights (filtered to valid rows) */
export type LocationInsightsRow = {
  entity_id: string;
  review_target_weekly: number;
  with_zoca_6_month_profile_clicks: number;
  insights_generated_at: string;
};

/** Per-entity YTD booking enquiries */
export type BookingEnquiriesRow = {
  entity_id: string;
  ytd_leads: number;
  prior_ytd_leads: number;
};

/** Composite per-entity performance metrics + flag verdict */
export type PerformanceMetrics = {
  entity_id: string;
  // GBP clicks
  gbp_clicks_peak_complete_month: number | null;
  gbp_clicks_current_complete_month: number | null;
  gbp_clicks_in_progress_month: number | null;
  gbp_clicks_drop_pct: number | null;        // (peak - current) / peak * 100
  // Leads YTD
  ytd_leads: number | null;
  prior_ytd_leads: number | null;
  ytd_leads_change_pct: number | null;
  // Rankings distribution
  active_ranking_count: number | null;
  rankings_top_3: number | null;
  rankings_top_10: number | null;
  rankings_outside_10: number | null;
  // Reviews
  reviews_last_12_weeks_total: number | null;
  weeks_with_zero_reviews: number | null;
  review_target_weekly: number | null;
  // Flag verdict (true = performance trajectory concerning)
  flag: boolean;
  flag_reasons: string[];                    // human-readable list of triggers
};

// ---------------------------------------------------------------------------
// v2 — Tickets metrics.
//
// Phase 31.v2 extends this with `records` + aggregates fed from the Metabase
// CSV. `open_tickets_30d` and `unresolved_issues_last_30_days` are still
// surfaced from BaseSheet as the legacy fallback signal (they pre-date the
// per-ticket feed and remain useful when the Metabase fetch fails).
//
// The Phase 31.v2 fields are optional at the type level so that
// `computeTicketsFlag()` (which only knows the BaseSheet counters) keeps
// compiling. `lib/refresh.ts` always merges the Metabase aggregates onto
// the same object before pushing it into the snapshot, so the dashboard
// reads them as if they were required at runtime.
// ---------------------------------------------------------------------------
export type TicketsMetrics = {
  entity_id: string;
  // Legacy BaseSheet-derived counters (kept for backward compat)
  open_tickets_30d: number;
  unresolved_issues_last_30_days: number;
  flag: boolean;
  // Phase 31.v2 — Metabase-derived per-ticket detail + aggregates.
  // Optional in the type so legacy scoring code keeps compiling; the snapshot
  // refresh pipeline always sets them.
  records?: UnifiedTicket[];
  open_count?: number;
  open_stale_count?: number;
  closed_last_30d_count?: number;
  by_category?: Record<string, number>;
  oldest_open_age_days?: number | null;
};

// ---------------------------------------------------------------------------
// v2 — Hybrid composite signals
// ---------------------------------------------------------------------------
export type CustomerSignalsV2 = {
  composite: number;
  tier: Tier;
  stoplight: Stoplight;
  // Per-signal sub-scores (0-100)
  sig_we_silent: number;
  sig_client_silent: number;
  sig_response_drop: number;
  sig_volume_collapse: number;
  sig_usage: number;
  sig_billing: number;
  // Modifier flags
  flag_performance: boolean;
  flag_tickets: boolean;
  flag_count: number;
  // Trajectory: composite delta vs. 7d ago (filled by snapshot writer when prev exists)
  trajectory_7d: "improving" | "worsening" | "stable" | "unknown";
  composite_7d_ago: number | null;
  // Narrative + suggested next action (template-driven, Haiku-substitutable later)
  reason_one_line: string;
  suggested_action: string;
  notes: string;
  // Pre-launch: Chargebee sub is "future" or activated_at hasn't passed.
  // When true, the customer skips normal churn-scoring (would peg RED/HIGH
  // due to zero comms/usage/billing) and gets a neutral GREEN/HEALTHY state.
  pre_launch: boolean;
};

export type MatchSource = "customer_id" | "bizname" | "unmatched";

/** v1 scored customer (preserved for backward compat) */
export type ScoredCustomer = {
  customer_id: string;
  entity_id: string;
  subscription_id: string;
  company: string;
  email: string;
  phone: string;
  am_name: string;
  ae_name: string;
  sp_name: string;
  cb_status: string;
  auto_collection: string | null;
  plan_amount: number;
  mrr_basesheet: string;
  zoca_status: string;
  churn_potential_flag: string;
  activated_at: string | null;
  ob_date: string;
  match_source: MatchSource;
  in_chrone: boolean;
  metrics: CustomerMetrics;
  signals: CustomerSignals;
};

/** HubSpot-derived data joined per customer (Phase 13). All optional — null when
 *  HubSpot Stage D didn't run or no matching company was found by bizname. */
export type HubspotJoinFields = {
  hubspot_company_id?: string;
    /** Phase 33.D — HubSpot Locations custom object record id (replaces company id for URL). */
    hubspot_location_record_id?: string;
  icp_tier?: "Tier 1" | "Tier 2" | "Tier 3" | null;
  lifecycle_drift?: boolean;                // HubSpot lifecycle ≠ "customer" but Chargebee says active
  open_deal_count?: number;
  open_deal_stages?: string[];
  total_open_amount?: number;
  last_call?: {
    note_id: string;
    date: string;
    sentiment: "warm" | "neutral" | "frustrated" | "unknown";
    topics: string[];
    action_items: string[];
    fireflies_url: string | null;
  } | null;
  /**
   * Phase 14B (Tier C): comms drift between HubSpot calls (30d) and Metabase
   * phone CSV (30d). Only set when |delta| >= 3. Positive delta = HubSpot has
   * more calls than Metabase (Metabase isn't catching them); negative delta
   * = Metabase has more (HubSpot isn't capturing them).
   */
  comms_drift?: {
    hubspot_calls_30d: number;
    metabase_calls_30d: number;
    delta: number;
  } | null;
  /**
   * Phase 14C (Tier E): top 5 contacts at the company by last activity.
   * Drives the CONTACTS section in the V2 customer card "Why?" expand.
   */
  contacts?: Array<{
    contact_id: string;
    name: string;
    email: string | null;
    job_title: string | null;
    last_activity: string | null;
  }>;
};

/** v2 scored customer — superset of v1 with usage, billing, performance, tickets, pod */
export type ScoredCustomerV2 = ScoredCustomer & {
  pod: string;                              // "Pod 1" - "Pod 5" / "Floating" / ""
  usage: UsageMetrics | null;
  billing: BillingMetrics | null;
  performance: PerformanceMetrics | null;
  tickets: TicketsMetrics | null;
  signals_v2: CustomerSignalsV2;
  hubspot?: HubspotJoinFields | null;
  /** Phase 33.scope — recently_churned | newly_onboarded | resurrected | active. */
  lifecycle_state?: "active" | "recently_churned" | "newly_onboarded" | "resurrected";
  /** Phase 33.scope — ISO string when cancelled_at landed (for recently_churned). */
  churned_on?: string | null;
  /** Phase 33.scope — ISO string of first activated_at across customer's subs. */
  onboarded_on?: string | null;
};

export type AmTierRow = {
  am: string;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  HEALTHY: number;
  total: number;
};

export type PodTierRow = {
  pod: string;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  HEALTHY: number;
  total: number;
  ams: string[];
};

export type DataHealth = {
  totalSubsFetched: number;
  customersWithEntityId: number;
  customersWithAnyComms90d: number;
  customersWithMixpanelData: number;        // v2
  customersWithBillingIssues: number;       // v2
  customersWithPerformanceFlag: number;     // v2
  customersWithTicketsFlag: number;         // v2
  matchBreakdown: {
    byCustomerId: number;
    byBizName: number;
    unmatched: number;
    notInChrone: number;
  };
  perSourceEventCount: {
    chat: number; email: number; phone: number; video: number; sms: number;
  };
  perSourceRawRows: {
    chat: number; email: number; phone: number; video: number; sms: number;
  };
  perDirectionCount: { in: number; out: number };
  duplicateEventsRemoved: number;
  baseSheetRowCount: number;
  mixpanelRowCount: number;                 // v2
  performanceRowCounts: {                   // v2 — per Metabase card
    gbpClicksMonthly: number;
    rankings: number;
    reviews12w: number;
    locationInsights: number;
    bookingEnquiries: number;
  };
  chargebeeInvoiceCount: number;            // v2
  chargebeeTransactionCount: number;        // v2
  excludedEntities: number;
  multiEntityExpansion: number;
  fetchErrors: string[];
  refreshDurationMs: number;
};

/** v1 snapshot — preserved for backward compat */
export type Snapshot = {
  generatedAt: string;
  todayIso: string;
  totalActive: number;
  tierCounts: Record<Tier, number>;
  signalCounts: {
    we_silent_any: number;
    client_silent_any: number;
    response_drop_any: number;
    volume_collapse_any: number;
  };
  channelCounts: {
    d30: Record<string, number>;
    d90: Record<string, number>;
  };
  amExposure: { am: string; high: number; total: number }[];
  amTierBreakdown: AmTierRow[];
  scoreDistribution: number[];
  customers: ScoredCustomer[];
  stats: {
    total_comms_90d: number;
    median_30d: number;
    mean_30d: number;
    median_90d: number;
    mean_90d: number;
    fetch_duration_ms: number;
  };
  health: DataHealth;
  errors?: string[];
};

/** v2 snapshot — superset with usage/billing/performance + pod rollups */
export type SnapshotV2 = Omit<Snapshot, "customers"> & {
  version: "v2";
  customers: ScoredCustomerV2[];
  stoplightCounts: Record<Stoplight, number>;
  signalCountsV2: {
    we_silent_any: number;
    client_silent_any: number;
    response_drop_any: number;
    volume_collapse_any: number;
    usage_dormant: number;
    billing_crisis: number;
    performance_flagged: number;
    tickets_flagged: number;
  };
  podBreakdown: PodTierRow[];
  activeEntityIds: string[];                // 922-ish from Chargebee × BaseSheet intersect
  mixpanelCoverage: {
    activeWithMixpanel: number;
    activeWithoutMixpanel: number;
  };
  /** Phase 13.1: data-scope metadata for UI scope strip and pipeline guard. */
  scope?: {
    universe: "chargebee_active_sub";
    statuses: readonly string[];
    customer_count: number;
    customer_id_count: number;
    multi_location_count: number;
    /** Phase 33.scope — sibling counts; customer_count stays as live universe. */
    recently_churned_count?: number;
    newly_onboarded_count?: number;
    resurrected_count?: number;
  };
};

export type RefreshResult = {
  ok: boolean;
  generatedAt: string;
  totalActive: number;
  durationMs: number;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Postgres — daily snapshot rows
// ---------------------------------------------------------------------------
export type DashboardSnapshotRow = {
  snapshot_date: string;          // YYYY-MM-DD
  generated_at: string;           // ISO timestamp
  total_customers: number;
  total_high_risk: number;
  total_watch: number;
  total_medium: number;
  total_low: number;
  total_healthy: number;
  customer_data: SnapshotV2;
  data_sources_status: Record<string, string>;
  refresh_duration_ms: number;
};

export type ContactReasonCode =
  | "renewal"
  | "performance"
  | "billing"
  | "complaint"
  | "check_in"
  | "onboarding"
  | "other";

export type AmActionType =
  | "contacted_connected"
  | "contacted_vm"
  | "contacted_noreach"
  | "escalated";

export type AmActionRow = {
  id?: number;
  am_name: string;
  entity_id: string;
  action_type: AmActionType;
  note?: string | null;
  composite_at_action?: number | null;
  reason_code?: ContactReasonCode | null;
  follow_up_date?: string | null;       // YYYY-MM-DD
  escalated_to?: string | null;          // AM name of pod lead
  created_at?: string;
};

export type OutcomeTrackingRow = {
  action_id: number;
  evaluated_at?: string;
  days_after: number;
  tier_at_action: string;
  tier_now: string;
  composite_at_action: number | null;
  composite_now: number | null;
  recovered: boolean;
};

export type HealthCheckLogRow = {
  id?: number;
  checked_at?: string;
  ok: boolean;
  probes: Record<string, { ok: boolean; latencyMs: number; error?: string }>;
  error_count: number;
  alerted: boolean;
};

export type SignalFeedbackRow = {
  id?: number;
  entity_id: string;
  signal_name: string;
  am_name: string;
  comment?: string | null;
  created_at?: string;
};
