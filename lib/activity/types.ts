/**
 * Umbrella-wide activity-log types. Phase E-8.
 *
 * Before E-8, activity logging lived in lib/customer/* and only tracked
 * Customer Beacon clicks. This module is the umbrella's source of truth for
 * event/surface taxonomies across all four agents. lib/customer/activity.ts
 * imports from here (and re-exports the customer-specific subset) so the
 * existing Customer Beacon call sites keep working unchanged.
 *
 * Adding a new event:
 *   1. Append to the right per-agent union below
 *   2. Add to ALL_EVENT_NAMES at the bottom
 *   3. Fire it from the relevant component with useActivityLogger()
 *   4. (Optional) Add the corresponding "label" entry in the
 *      slack-activity-digest cron if you want it to appear in the
 *      hourly Slack rollup.
 */

export type Agent = "customer" | "performance" | "escalation" | "post-payment" | "miss-payment" | "negative-keyword" | "umbrella";

export const AGENTS: readonly Agent[] = [
  "customer",
  "performance",
  "escalation",
  "post-payment",
  "miss-payment",
  "negative-keyword",
  "umbrella",
] as const;

// --- Customer Beacon ---------------------------------------------------------
// Pre-existing taxonomy. Do NOT remove names without a corresponding cleanup
// of am_activity_log rows + slack-activity-digest grouping.
export type CustomerEvent =
  | "page_view"
  | "refresh_clicked"
  | "filter_changed"
  | "sort_changed"
  | "am_switched"
  | "view_switched"
  | "customer_opened"
  | "mark_contacted"
  | "note_saved"
  | "snooze_set"
  | "one_on_one_opened"
  | "coaching_acted"
  | "coaching_dismissed";

export type CustomerSurface =
  | "v2_dashboard"
  | "v2_customer_detail"
  | "v2_manager_1on1"
  | "v2_coaching"
  | "v2_timeline"
  | "admin_usage";

// --- Performance Beacon ------------------------------------------------------
export type PerformanceEvent =
  | "page_view"
  | "report_generated"
  | "report_opened"
  | "recent_report_clicked"
  | "customer_searched"
  | "preview_closed";

export type PerformanceSurface =
  | "performance_landing"
  | "performance_report";

// --- Escalation Beacon -------------------------------------------------------
export type EscalationEvent =
  | "page_view"
  | "search_submitted"
  | "tab_switched"
  | "ticket_opened"
  | "customer_opened"
  | "queue_filter_changed";

export type EscalationSurface =
  | "escalation_home"
  | "escalation_queue"
  | "escalation_triage"
  | "escalation_tickets"
  | "escalation_customer";

// --- Post-Payment Reviews ----------------------------------------------------
export type PostPaymentEvent =
  | "page_view"
  | "customer_opened"
  | "verdict_filter_changed"
  | "rerun_clicked"
  | "docx_opened"
  | "rerender_clicked";

export type PostPaymentSurface =
  | "post_payment_dashboard"
  | "post_payment_report";

// --- Miss Payment Beacon -----------------------------------------------------
// Phase F port — Finance-ops unpaid-invoice tracker. Click instrumentation
// stays light at v1 (just page_view + the refresh + filter events that map
// cleanly to existing names). Annotation saves intentionally NOT logged —
// Finance reps edit dozens of cells per session and we don't want to flood
// the activity log with low-signal events.
export type MissPaymentEvent =
  | "page_view"
  | "refresh_clicked"
  | "filter_changed"
  | "excel_exported"
  | "annotation_saved";

export type MissPaymentSurface =
  | "miss_payment_home";

// --- Negative Keyword Beacon ------------------------------------------------
// Phase NK port. AI-classified negative-signal alerts surfaced as Linear
// retention-risk tickets. Click instrumentation tracks the operator
// workflow: which alert categories get triaged, how often AMs create vs
// dismiss, and which tabs they spend time on.
export type NegativeKeywordEvent =
  | "page_view"
  | "tab_switched"
  | "filter_changed"
  | "alert_opened"
  | "ticket_created"
  | "ticket_creation_failed"
  | "alert_dismissed";

export type NegativeKeywordSurface =
  | "negative_keyword_home"
  | "negative_keyword_alerts"
  | "negative_keyword_tickets";

// --- Umbrella (cross-agent infra) -------------------------------------------
// Auth, launcher, things that don't belong to one specific agent.
export type UmbrellaEvent =
  | "sign_in"
  | "sign_in_rejected"
  | "launcher_card_clicked"
  | "sign_out"
  | "api_call"
  // Phase E-9 — Cmd+K command palette telemetry
  | "command_palette_opened"
  | "command_palette_select"
  // Phase E-9 — Customer 360 ask-Claude
  | "claude_asked"
  // Phase E-9 Evolving Beacon — fact memory
  | "fact_remembered"
  | "fact_forgotten"
  | "fact_extracted"
  // Phase E-9 — Beacon AI proactive suggestions
  | "suggestion_offered"
  | "suggestion_acted";

export type UmbrellaSurface =
  | "auth"
  | "launcher";

// --- Aggregated unions -------------------------------------------------------
export type AnyEvent =
  | CustomerEvent
  | PerformanceEvent
  | EscalationEvent
  | PostPaymentEvent
  | MissPaymentEvent
  | NegativeKeywordEvent
  | UmbrellaEvent;

export type AnySurface =
  | CustomerSurface
  | PerformanceSurface
  | EscalationSurface
  | PostPaymentSurface
  | MissPaymentSurface
  | NegativeKeywordSurface
  | UmbrellaSurface;

/** Validates an arbitrary string against the union of all known event names. */
export const ALL_EVENT_NAMES: readonly string[] = [
  // customer
  "page_view", "refresh_clicked", "filter_changed", "sort_changed",
  "am_switched", "view_switched", "customer_opened", "mark_contacted",
  "note_saved", "snooze_set", "one_on_one_opened", "coaching_acted",
  "coaching_dismissed",
  // performance
  "report_generated", "report_opened", "recent_report_clicked",
  "customer_searched", "preview_closed",
  // escalation
  "search_submitted", "tab_switched", "ticket_opened", "queue_filter_changed",
  // post-payment
  "verdict_filter_changed", "rerun_clicked", "docx_opened", "rerender_clicked",
  // miss-payment
  "excel_exported", "annotation_saved",
  // negative-keyword
  "alert_opened", "ticket_created", "ticket_creation_failed", "alert_dismissed",
  // umbrella
  "sign_in", "sign_in_rejected", "launcher_card_clicked", "sign_out", "api_call",
  "command_palette_opened", "command_palette_select", "claude_asked",
  "fact_remembered", "fact_forgotten", "fact_extracted",
  "suggestion_offered", "suggestion_acted",
] as const;

export const ALL_SURFACES: readonly string[] = [
  // customer
  "v2_dashboard", "v2_customer_detail", "v2_manager_1on1", "v2_coaching",
  "v2_timeline", "admin_usage",
  // performance
  "performance_landing", "performance_report",
  // escalation
  "escalation_home", "escalation_queue", "escalation_triage",
  "escalation_tickets", "escalation_customer",
  // post-payment
  "post_payment_dashboard", "post_payment_report",
  // miss-payment
  "miss_payment_home",
  // negative-keyword
  "negative_keyword_home", "negative_keyword_alerts", "negative_keyword_tickets",
  // umbrella
  "auth", "launcher",
] as const;

export function isKnownEvent(name: string): name is AnyEvent {
  return ALL_EVENT_NAMES.includes(name);
}

export function isKnownSurface(s: string): s is AnySurface {
  return ALL_SURFACES.includes(s);
}

export function isKnownAgent(a: string): a is Agent {
  return AGENTS.includes(a as Agent);
}
