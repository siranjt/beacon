/**
 * Negative Keyword Beacon — shared types. Phase NK-2.
 *
 * Single source of truth for the agent's domain shapes. Mirrors the
 * `beacon_negative_keyword_alerts` table columns 1:1 — the repo layer
 * UPSERTs the exact shape `AlertItem` defines, and reads return it.
 *
 * The display values for `AlertSource` are deliberate — they match the
 * doc spec ("App Chat" / "Email" / "SMS" / "Phone" / "Video") rather
 * than the lowercase comms-feed-v2 channel names. This keeps the UI
 * source filter and the Linear ticket description text consistent.
 */

/** Channel as surfaced in the dashboard + tickets. */
export const ALERT_SOURCES = ["App Chat", "Email", "SMS", "Phone", "Video"] as const;
export type AlertSource = (typeof ALERT_SOURCES)[number];

/** Map comms-feed-v2's lowercase channel → AlertSource display value. */
export const CHANNEL_TO_SOURCE: Record<string, AlertSource> = {
  chat: "App Chat",
  email: "Email",
  sms: "SMS",
  phone: "Phone",
  video: "Video",
};

/** Risk category — assigned by Haiku, or by regex fallback. */
export const RISK_CATEGORIES = [
  "Cancellation",
  "Billing",
  "Lead quality",
  "Technical",
  "Disappointed",
  "Flagged",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/** Which path produced the row — for analytics + bug triage. */
export type Classifier = "ai" | "regex-fallback";

/**
 * Pre-classification candidate. Output of feeds.ts + prescreen.ts,
 * input to classify.ts. Carries enough metadata for the classifier to
 * write a useful row plus enough for the de-duper to detect repeats.
 */
export interface CandidateMessage {
  /** Customer entity_id (UUID) — joins to BaseSheet. */
  entity_id: string;

  /** Display-shape channel name. */
  source: AlertSource;

  /** Original sub-classification from comms-feed-v2 (e.g. "twilio_sms"). */
  subtype: string;

  /** ISO-8601 timestamp at the wire. */
  created_at: string;

  /** Epoch ms — convenient for sort/window math. */
  ts: number;

  /** "inbound" = customer sent, "outbound" = Zoca sent, "system" = automation. */
  direction: "inbound" | "outbound" | "system";

  /** Display name for the sender (customer name, AM name, or "System"). */
  sender_name: string;

  /** Message content — may be empty/sparse for Phone (transcript-only) and
   * always empty for Video (metadata-only). */
  message_body: string;

  /** False when the upstream channel didn't carry a transcript (Video,
   * sometimes Phone). Pre-screen routes these to the Flagged-only path. */
  body_available: boolean;

  /** Channel-native id (twilio sid, sendgrid msg id, fireflies id, etc.).
   * Used as the source_id fallback when message_body is sparse. */
  source_id: string;
}

/**
 * Full alert row — output of the cron pipeline, mirrors DB columns.
 * `id` is null until the repo INSERTs the row (gen_random_uuid()).
 */
export interface AlertItem {
  id: string | null;

  // --- Identity ---
  entity_id: string;
  customer_id: string | null;
  business_name: string;
  am_name: string | null;
  owning_am_email: string; // routes orphans to siranjith.t@zoca.com

  // --- Message metadata ---
  source: AlertSource;
  subject: string | null;
  message_body: string | null;
  message_date: string; // YYYY-MM-DD
  message_time: string | null; // HH:MM:SS
  sender: string | null;

  // --- Classification ---
  risk_category: RiskCategory;
  analysis: string;
  classifier: Classifier;

  // --- Dedup ---
  dedup_key: string;

  // --- Ticket lifecycle ---
  ticket_id: string | null;
  ticket_identifier: string | null;
  ticket_url: string | null;
  ticket_created_at: string | null;
  ticket_created_by_email: string | null;

  // --- Dismissal lifecycle ---
  dismissed_at: string | null;
  dismissed_by_email: string | null;
  dismissed_reason: string | null;

  // --- Timestamps ---
  created_at: string;
  last_seen_at: string;
}

/**
 * Compose the unique dedup key for one message. Doc spec: source +
 * entity_id + first 80 chars of message_body. Video gets the source_id
 * appended since its body is always empty.
 */
export function buildDedupKey(
  source: AlertSource,
  entityId: string,
  messageBody: string,
  sourceIdFallback: string,
): string {
  const body = (messageBody || "").trim().slice(0, 80);
  const tail = body || `__no-body__${sourceIdFallback}`;
  return `${source}::${entityId}::${tail}`;
}

/** Orphan-routing constant. Wired in enrich.ts. */
export const ORPHAN_OWNER_EMAIL = "siranjith.t@zoca.com";

/** 14-day window per phase-NK design. */
export const NK_WINDOW_DAYS = 14;
