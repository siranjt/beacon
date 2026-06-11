// Static config: Metabase public CSV endpoints + scoring constants.
// These UUIDs come from Zoca's Metabase and are stable.

export const METABASE_ENDPOINTS = {
  // BS-1 (2026-06-10): swapped from the legacy 87763e8c question to the new
  // optimized e9005a5c question. The legacy CSV embedded churn-potential +
  // open-tickets columns inline; the new CSV is lean (identity + AM mapping
  // + contact + payment only). The dropped fields are now pulled from the
  // `baseSheetSupplement` URL below and merged onto each BaseSheetRow at
  // parse time (lib/customer/metabase.ts:fetchBaseSheet).
  baseSheet:            "https://metabase.zoca.ai/public/question/e9005a5c-4b5c-405d-af35-a69063c996e5.csv",
  baseSheetSupplement:  "https://metabase.zoca.ai/public/question/385231ff-4bc9-4b5d-a300-3b16a0fab7be.csv",
  chat:                 "https://metabase.zoca.ai/public/question/10a52e37-04fa-4422-b840-803b66e033bf.csv",
  email:                "https://metabase.zoca.ai/public/question/7a5aa1f6-9205-4e83-be51-3e585aa0f4a8.csv",
  phone:                "https://metabase.zoca.ai/public/question/60797a27-c546-450d-b00b-a51b7e490143.csv",
  video:                "https://metabase.zoca.ai/public/question/d95d9354-7c84-4a57-8af5-e700580c6ecb.csv",
  sms:                  "https://metabase.zoca.ai/public/question/bbaad2fb-5f9d-4249-af59-c7812851437c.csv",
  // Phase 31.v2 — Metabase tickets CSV (active Linear + closed in last 30d)
  tickets:              "https://metabase.zoca.ai/public/question/a80bac40-c055-4867-a778-9ee1f29053ca.csv",
} as const;

// Phase 31.v2 — tickets enrichment constants (restored after Phase 33.A overwrite)
export const TICKETS_STALE_DAYS = 7;
export const TICKETS_MAX_RECORDS_PER_CUSTOMER = 20;

// ---------------------------------------------------------------------------
// v2 rework — new Metabase cards backing product-usage + performance signals
// All 6 cards live as of 2026-05-12. See docs/v2-design.md Appendix A.
// ---------------------------------------------------------------------------
export const METABASE_V2_ENDPOINTS = {
  mixpanelRollup:    "https://metabase.zoca.ai/public/question/b0809829-84ed-4e15-9857-2a54bf6d6e10.csv",
  gbpClicksMonthly:  "https://metabase.zoca.ai/public/question/fbed2414-174f-4d0d-9742-9d916447b4c1.csv",
  rankings:          "https://metabase.zoca.ai/public/question/fb6cd09f-e6f2-4a33-b7c8-d9cca1e10252.csv",
  reviews12w:        "https://metabase.zoca.ai/public/question/291e294a-2b9a-48e6-8952-35d6ba9a49e4.csv",
  locationInsights:  "https://metabase.zoca.ai/public/question/2da65c3d-2cda-406a-984c-ef4730cdb027.csv",
  bookingEnquiries:  "https://metabase.zoca.ai/public/question/1aa92a55-824d-4606-a26e-6239353beb93.csv",
} as const;

export const WINDOWS_DAYS = [7, 14, 30, 60, 90] as const;
export const COMMS_RETAIN_DAYS = 120;

// ---------------------------------------------------------------------------
// v1 composite weights (kept for backward compatibility with existing dashboard)
// ---------------------------------------------------------------------------
export const SIG_WEIGHTS = {
  weSilent:       0.30,
  clientSilent:   0.30,
  responseDrop:   0.25,
  volumeCollapse: 0.15,
} as const;

// ---------------------------------------------------------------------------
// v2 hybrid composite weights — Comms 50% / Usage 30% / Billing 20%
// Internal comms sub-weights sum to 0.5; absolute weights when flattened.
// ---------------------------------------------------------------------------
export const SIG_WEIGHTS_V2 = {
  // Comms pillar (sums to 0.50)
  weSilent:       0.15,
  clientSilent:   0.15,
  responseDrop:   0.12,
  volumeCollapse: 0.08,
  // Product usage (Mixpanel)
  usage:          0.30,
  // Billing health (Chargebee invoices + transactions)
  billing:        0.20,
} as const;

// Sanity: weights must sum to 1.0
export const SIG_WEIGHTS_V2_SUM = Object.values(SIG_WEIGHTS_V2).reduce((a, b) => a + b, 0);

export const TIER_CUTS = {
  high:   65,
  medium: 35,
  low:    15,
} as const;

// ---------------------------------------------------------------------------
// SV-9a — Safety-net floor on the V2 composite.
//
// Background: the weighted-sum composite can fall well below TIER_CUTS.medium
// even when individual sub-scores are pegged at 100. Pearls Dry Bar (2026-06-09)
// had sig_client_silent=100, sig_volume_collapse=100, flag_performance=true,
// composite=26 → GREEN. The shadow-verdict LLM caught it; the engine missed it.
//
// Fix: after the weighted sum is computed, if ≥1 catastrophic structural
// signal fires we apply a MIN floor of YELLOW (60) or RED (80) to the composite.
// The original weighted sum is preserved in `composite_weighted_raw` notes for
// forensics; the tier-determination uses MAX(weighted, floor).
//
// Triggers chosen to be non-noisy on low-traffic accounts:
//   - we exclude sig_we_silent / sig_response_drop (these can spike on
//     accounts with no traffic at all, where there's nothing to drop from)
//   - we exclude sig_usage (Mixpanel coverage gaps cause false positives)
//
// See [[shadow-verdict-day1-finding]] for the day-1 evidence that motivated
// this floor.
// ---------------------------------------------------------------------------
export const SAFETY_FLOOR = {
  // Sub-score thresholds at which each individual signal "counts" toward the floor.
  CLIENT_SILENT_THRESHOLD: 80,
  VOLUME_COLLAPSE_THRESHOLD: 80,
  BILLING_THRESHOLD: 60,
  // Floor levels.
  FLOOR_YELLOW: 60, // 1 trigger fires
  FLOOR_RED: 80,    // ≥2 triggers fire
} as const;

export type Tier = "HIGH" | "MEDIUM" | "LOW" | "HEALTHY";
export const TIER_ORDER: Tier[] = ["HIGH", "MEDIUM", "LOW", "HEALTHY"];

// ---------------------------------------------------------------------------
// v2 AM-facing stoplight (3 colors). Internal 5-tier model still exists in
// lib/scoring.ts; this is the display-layer compression for AM-facing UI.
// ---------------------------------------------------------------------------
export type Stoplight = "RED" | "YELLOW" | "GREEN";
export const STOPLIGHT_LABELS: Record<Stoplight, string> = {
  RED:    "Needs attention",
  YELLOW: "Keep an eye on",
  GREEN:  "Doing fine",
};

/** Map internal 5-tier (+ WATCH lane + billing override) to AM-facing 3-color stoplight */
export function tierToStoplight(
  tier: Tier,
  flagCount: number,
  billingScore: number = 0,
): Stoplight {
  if (tier === "HIGH") return "RED";
  if (tier === "MEDIUM") return "YELLOW";
  // Billing crisis override: stacked unpaid invoices always surface, even with
  // otherwise-active comms/usage. Phase 1.2 finding from cohort validation.
  if (billingScore >= BILLING_YELLOW_OVERRIDE) return "YELLOW";
  // WATCH lane: HEALTHY/LOW with 2+ modifier flags surfaces as Yellow
  if ((tier === "LOW" || tier === "HEALTHY") && flagCount >= 2) return "YELLOW";
  return "GREEN";
}

// Phase 33.brand-watchfire-T5 — TIER/STOPLIGHT/CHANNEL palettes swept to Watchfire.
export const TIER_COLORS: Record<Tier, string> = {
  HIGH:    "#7C2D12", // Deep Crimson
  MEDIUM:  "#D9A441", // Brass
  LOW:     "#2A4D5C", // Sea Lapis
  HEALTHY: "#4A7C59", // Patina
};

export const STOPLIGHT_COLORS: Record<Stoplight, string> = {
  RED:    "#C8431D", // Ember
  YELLOW: "#D9A441", // Brass
  GREEN:  "#4A7C59", // Patina
};

export const CHANNEL_COLORS: Record<string, string> = {
  chat:  "#2A4D5C", // Sea Lapis
  phone: "#4A7C59", // Patina
  video: "#C8431D", // Ember
  sms:   "#D9A441", // Brass
  email: "#6E5F50", // Smoke
};

export const SNAPSHOT_KEY = "disengagement:snapshot:latest";

export const WE_SILENT_DAYS = { high: 60, med: 30, low: 14 };
export const CLIENT_SILENT_DAYS = { high: 45, med: 30, low: 14 };
export const ZERO_COMMS_BASELINE_SCORE = 85;

// ---------------------------------------------------------------------------
// v2 — Product-usage scoring (Mixpanel-derived)
// Engagement tier thresholds based on 30-day event counts + last-open recency
// ---------------------------------------------------------------------------
export type EngagementTier = "Active" | "Light" | "Cold" | "Dormant";

export const USAGE_TIER_THRESHOLDS = {
  // Active: opened app on 10+ distinct days in last 30
  activeDistinctDaysMin: 10,
  // Light: opened on 3-9 days in last 30
  lightDistinctDaysMin: 3,
  // Cold: opened on 1-2 days OR no opens but other events in last 30
  // Dormant: zero events in last 30 days
} as const;

// Map engagement tier → 0-100 usage signal risk score
export const USAGE_TIER_TO_SCORE: Record<EngagementTier, number> = {
  Active:  10,
  Light:   35,
  Cold:    65,
  Dormant: 95,
};

export const ZERO_MIXPANEL_BASELINE_SCORE = 100;

// ---------------------------------------------------------------------------
// v2 — Billing health scoring
// ---------------------------------------------------------------------------
export const BILLING_THRESHOLDS = {
  // Unpaid invoice count thresholds (sub-score 0-100)
  unpaidCount: { high: 3, med: 2, low: 1 },
  // Days past oldest unpaid invoice
  daysOverdue: { high: 30, med: 15, low: 7 },
  // Auto-debit-off with recent failures → bonus risk
  autoDebitOffWithFailuresBonus: 25,
  // ACH in-progress → negative modifier (payment on the way)
  achInProgressDiscount: 15,
} as const;

// ---------------------------------------------------------------------------
// v2 — Performance trajectory flag thresholds
// ---------------------------------------------------------------------------
export const PERFORMANCE_FLAG_THRESHOLDS = {
  gbpClicksDropPctMin: 25,    // GBP clicks down ≥25% on complete-month basis
  ytdLeadsDropPctMin:  20,    // YTD leads trailing same period last year ≥20%
  // Note: rankings-degradation flag requires a rank-when-joined baseline which
  // the current Metabase card doesn't carry. Removed to avoid implying a
  // signal that doesn't fire. Re-add when the baseline lands.
  weeksWithZeroReviewsMin: 4, // 4+ weeks with zero reviews in last 12 weeks
} as const;

// ---------------------------------------------------------------------------
// v2 — WATCH lane: HEALTHY/LOW with 2+ modifier flags → AM-facing Yellow
// ---------------------------------------------------------------------------
export const WATCH_LANE_FLAG_COUNT = 2;

// v2 — Billing crisis override: any customer with billing_score >= this threshold
// surfaces at least YELLOW in the stoplight regardless of composite/tier.
// Catches the 'fresh comms + active app + stacked unpaid invoices' edge case.
export const BILLING_YELLOW_OVERRIDE = 40;

// ---------------------------------------------------------------------------
// v2 — Pods (per AM Transition Toolkit, hardcoded May 2026)
// ---------------------------------------------------------------------------
// AM-1 (2026-06-10): Removed Apurvaa Biswas + Santhosh V (no longer at Zoca).
// Promoted "Tanya Solanki" from INCOMING_AMS to ACTIVE_AMS (she has accounts
// now). Fixed spelling: BaseSheet has "Tanya Solanki" (single-a) — the
// previous "Taanya Solanki" entries were creating a phantom dropdown profile.
export const POD_MAP: Record<string, string> = {
  "Kanak sharma":   "Pod 1",
  "Sudha Goutami":  "Pod 1",
  "Hubern C":       "Pod 2",
  "Sakshi Mamgain": "Pod 2",
  "Bikash Mishra":  "Pod 3",
  "Anu Srivastava": "Pod 3",
  "Atharv Y":       "Pod 4",
  "Shruti Sinha":   "Pod 4",
  "Tanya Solanki":  "Pod 4",
  "Siddhi Shetty":  "Pod 5",
  "Kripali Suri":   "Pod 5",
  "Nikita Singh":   "Floating",
};

// Active AM list (June 2026)
export const ACTIVE_AMS = [
  "Sudha Goutami", "Sakshi Mamgain", "Hubern C", "Bikash Mishra", "Anu Srivastava",
  "Kanak sharma", "Atharv Y", "Shruti Sinha",
  "Siddhi Shetty", "Nikita Singh", "Kripali Suri", "Tanya Solanki",
] as const;

export const INCOMING_AMS: string[] = [];

// ---------------------------------------------------------------------------
// Phase E-17 Wave 3b — Slack user-id map for proactive Beacon AI DMs.
//
// The proactive briefing + daily anomaly digest crons need to DM each AM
// individually. Slack's chat.postMessage accepts a user id (U…) as the
// `channel` argument and opens (or reuses) the IM channel automatically.
//
// This map is intentionally empty in code — Slack workspace IDs are NOT
// public and shouldn't be checked in until we've collected them from the
// team. The proactive crons skip + log "no_slack_id" when an AM is not in
// the map, so they degrade gracefully until this is populated.
//
// Once we know the IDs, populate from a Slack admin tool (users.list scope
// on the bot token) or by collecting via /whoami in a test channel.
// ---------------------------------------------------------------------------
export const AM_SLACK_IDS: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Postgres (Neon) — for v2 snapshot history + AM actions + signal feedback
// POSTGRES_URL is auto-injected by Vercel when Neon is connected as Storage
// ---------------------------------------------------------------------------
export function pgConfigured(): boolean {
  return !!process.env.POSTGRES_URL;
}

export const SNAPSHOT_RETENTION_DAYS = 90;

// ---------------------------------------------------------------------------
// Entity-level exclude list
// ---------------------------------------------------------------------------
export const EXCLUDED_ENTITIES: Record<string, string> = {
  "7a82fdbb-f519-4d38-b3f9-b8dfd5760d0b": "Slayishhh Blast (test account)",
  "d2c8625f-fb4a-4376-973c-b02b36593b05": "Beauty by Hailey (orphan; customer_id links to other businesses)",
  "e2ac8f53-d1d9-4bce-b61d-9b4d14d0c4cc": "Image Sun Tanning Center (orphan; customer_id links to Fortitude CrossFit)",
  "8643a977-6dc5-4fcc-a957-cbb37062eccc": "Hollywood Skin Atlanta Sugar Hill (orphan; customer_id links to Hollywood Skin Atlanta)",
};

// ---------------------------------------------------------------------------
// Phase 33.B — Three-role access split with strict allowlist.
//
// Three roles:
//   • admin   — superuser. Inherits ALL manager + AM permissions plus
//               admin-exclusive (/admin/usage, role management, cron triggers,
//               integration health).
//   • manager — full cross-AM access. AM picker visible, manager view, 1:1
//               prep, all customer detail pages, all action mutations.
//   • am      — locked to their own book. Can ONLY view/mutate their own
//               customers.
//
// Anyone signing in with a Zoca email NOT in any of these three lists is
// rejected at the signIn callback (strict allowlist mode).
// ---------------------------------------------------------------------------

// Admin — hardcoded, do NOT add to MANAGER_EMAILS or AM_EMAILS
export const ADMIN_EMAILS: string[] = [
  "success@zoca.com",
  "siranjith.t@zoca.com",
  "rinitha.a@zoca.com",
];

// Manager — cross-AM access, all manager features, no admin-exclusive.
// Phase 33.B.1: Siddhi Shetty promoted from AM to Manager; Kripali Suri,
// Saibal Paul, and Vaibhav added as Managers (previously not on the list).
// Phase 33.B.7: ashish@zoca.com added alongside existing ashish@zoca.ai
// (both addresses now have manager access — collapse to one once Ashish
// confirms which is primary).
export const MANAGER_EMAILS: string[] = [
  "chetan.m@zoca.com",
  "robin@zoca.ai",
  "ashish@zoca.ai",
  "ashish@zoca.com",
  "abhishek.j@zoca.com",
  "siddhi.s@zoca.com",
  "kripali@zoca.ai",
  "kripali@zoca.com",
  "saibal.p@zoca.com",
  "vaibhav.v@zoca.com",
  "shakti.s@zoca.com",
];

// AM — locked to their own book only.
//   Phase 33.B.1: Siddhi removed (promoted to Manager).
//   AM-1 (2026-06-10): Apurvaa + Santhosh removed (no longer at Zoca).
// Net: 10 AMs.
export const AM_EMAILS: string[] = [
  "anu.s@zoca.com",
  "atharv.y@zoca.com",
  "bikash.m@zoca.com",
  "hubern.c@zoca.com",
  "kanak.s@zoca.com",
  "nikita.s@zoca.com",
  "sakshi.m@zoca.com",
  "shruti.s@zoca.com",
  "sudha.g@zoca.com",
  "tanya.s@zoca.com",
];

export type UserRole = "admin" | "manager" | "am";

/**
 * Resolve an email to a role. Case-insensitive. Returns null if the email
 * isn't in ANY of the three allowlists — those users are rejected at the
 * NextAuth signIn callback (strict allowlist mode, Phase 33.B).
 */
export function getRoleForEmail(email: string): UserRole | null {
  const e = (email || "").trim().toLowerCase();
  if (!e) return null;
  for (const adminEmail of ADMIN_EMAILS) {
    if (adminEmail.toLowerCase() === e) return "admin";
  }
  for (const managerEmail of MANAGER_EMAILS) {
    if (managerEmail.toLowerCase() === e) return "manager";
  }
  for (const amEmail of AM_EMAILS) {
    if (amEmail.toLowerCase() === e) return "am";
  }
  return null;
}

/**
 * Helper: is a role admin OR manager? (i.e., cross-AM access)
 * Used by both middleware and component-level rendering.
 */
export function isManagerOrAdmin(role: UserRole | null | undefined): boolean {
  return role === "admin" || role === "manager";
}

// ---------------------------------------------------------------------------
// Phase 33.E.2 — Metabase Customer Health card 4-tier model
// ---------------------------------------------------------------------------
export type HealthTier = "CRITICAL" | "AT-RISK" | "MONITOR" | "HEALTHY";

export const HEALTH_TIER_ORDER: HealthTier[] = ["CRITICAL", "AT-RISK", "MONITOR", "HEALTHY"];

export const HEALTH_TIER_LABELS: Record<HealthTier, string> = {
  "CRITICAL": "Critical — deal breaker",
  "AT-RISK":  "At risk",
  "MONITOR":  "Keep watching",
  "HEALTHY":  "Healthy",
};

// Phase 33.brand-watchfire — tier colors per spec §6.
export const HEALTH_TIER_COLORS: Record<HealthTier, string> = {
  "CRITICAL": "#7C2D12",  // Deep Crimson
  "AT-RISK":  "#C8431D",  // Ember
  "MONITOR":  "#D9A441",  // Brass
  "HEALTHY":  "#4A7C59",  // Patina
};

/** Normalize the raw tier string from Metabase ("CRITICAL - DEAL BREAKER", etc.) to our HealthTier union. */
export function normalizeHealthTier(raw: string | null | undefined): HealthTier | null {
  if (!raw) return null;
  const t = String(raw).toUpperCase().trim();
  if (t === "CRITICAL - DEAL BREAKER" || t === "CRITICAL") return "CRITICAL";
  if (t === "AT-RISK" || t === "ATRISK" || t === "AT_RISK") return "AT-RISK";
  if (t === "MONITOR") return "MONITOR";
  if (t === "HEALTHY") return "HEALTHY";
  return null;
}
