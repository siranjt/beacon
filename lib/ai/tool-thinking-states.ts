/**
 * BEAM-THINKING (2026-06-13) — single source of truth for the in-flight
 * "Beam is doing X" pill the AskPanel shows while a tool call is open.
 *
 * Lives outside the React tree so server-side analytics or Slack digest
 * copy can reach for the same labels without dragging in a client
 * component. Per-tool labels are deliberately verb-first so the pill
 * reads like a thought, not a status code.
 *
 * Two visual lanes:
 *   - "vault"  → Keeper-touching tools render with the spinning vault
 *                glyph (Direction C kernel). Reinforces "Beam is using
 *                the Keeper" the moment the animation fires.
 *   - "flame"  → Everything else renders with a small BeaconMark flicker.
 *                Default lane for all non-Keeper tools.
 *
 * Fallback label "Beam is thinking…" is used when an unknown tool name
 * sneaks in (e.g. a tool added without a label entry yet). Better than
 * leaving the pill blank, which is what kicked off this whole polish
 * pass — the bare gray rectangle Success saw in the smoke test.
 */

export type BeamThinkingKind = "vault" | "flame";

export interface BeamThinkingState {
  kind: BeamThinkingKind;
  label: string;
}

/**
 * Tool → thinking-state mapping. Verb-first labels keep the reading
 * cadence consistent ("Beam is opening the Keeper…", "Beam is pulling
 * billing…"). Bizname isn't substituted in — the pill renders below the
 * customer-named ActionCard in transcript order, so the subject is
 * already clear from context.
 */
const STATES: Record<string, BeamThinkingState> = {
  // Keeper-touching tools — vault glyph
  read_customer_brain: {
    kind: "vault",
    label: "Beam is opening the Keeper…",
  },
  query_brain: {
    kind: "vault",
    label: "Beam is searching the Keeper across the book…",
  },
  add_fact_to_brain: {
    kind: "vault",
    label: "Beam is teaching the Keeper…",
  },

  // Live-Metabase + Chargebee + customer-data tools — flame
  get_chargebee_billing: {
    kind: "flame",
    label: "Beam is pulling billing details…",
  },
  get_customer_performance: {
    kind: "flame",
    label: "Beam is reading performance data…",
  },
  read_customer_notes: {
    kind: "flame",
    label: "Beam is scanning customer notes…",
  },
  get_booking_history: {
    kind: "flame",
    label: "Beam is loading booking history…",
  },
  get_mixpanel_activity: {
    kind: "flame",
    label: "Beam is checking app activity…",
  },
  get_review_summary: {
    kind: "flame",
    label: "Beam is reading the reviews…",
  },
  get_basesheet_summary: {
    kind: "flame",
    label: "Beam is reading the BaseSheet…",
  },
  get_full_customer_view: {
    kind: "flame",
    label: "Beam is pulling everything together…",
  },
  lookup_customer: {
    kind: "flame",
    label: "Beam is looking up the customer…",
  },

  // Drafts — flame
  draft_email_to_contact: {
    kind: "flame",
    label: "Beam is drafting the email…",
  },
  draft_slack_message: {
    kind: "flame",
    label: "Beam is drafting the Slack message…",
  },

  // Book-level queries — flame
  query_customer_book: {
    kind: "flame",
    label: "Beam is querying the customer book…",
  },

  // Mutating actions — flame
  mark_contacted_today: {
    kind: "flame",
    label: "Beam is marking the customer contacted…",
  },
  snooze_customer: {
    kind: "flame",
    label: "Beam is snoozing the customer…",
  },
  pin_customer: {
    kind: "flame",
    label: "Beam is pinning the customer…",
  },
  add_note: {
    kind: "flame",
    label: "Beam is saving the note…",
  },
};

/**
 * Look up the thinking-state for a tool name. Unknown tools fall back
 * to a generic flame + "Beam is thinking…" rather than rendering a blank
 * pill. Exported as a pure function so it's trivially testable.
 */
export function getBeamThinkingState(toolName: string | null | undefined): BeamThinkingState {
  if (!toolName) return { kind: "flame", label: "Beam is thinking…" };
  const hit = STATES[toolName];
  if (hit) return hit;
  return { kind: "flame", label: "Beam is thinking…" };
}
