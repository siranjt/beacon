/**
 * Action library types — vertical-keyed playbooks of report-section copy.
 *
 * The hybrid model:
 *   1. Signals (lib/report/signals.ts) inspect the data and decide WHICH
 *      actions trigger, with what priority, and supply personalization values.
 *   2. The library (this folder) provides the vertical-flavored COPY for
 *      each triggered action.
 *   3. The combiner (lib/report/checklist.ts) merges the two.
 */

export type ActionId =
  | "upload_photos"
  | "run_offer"
  | "use_app_more"
  | "respond_to_reviews"
  | "returning_client_incentive";

export const ALL_ACTION_IDS: readonly ActionId[] = [
  "upload_photos",
  "run_offer",
  "use_app_more",
  "respond_to_reviews",
  "returning_client_incentive",
] as const;

export type ActionEmphasis = "high_impact" | "urgent" | "normal";

/** A small typed table that sometimes accompanies an action (e.g. offer prices). */
export type ActionTable = {
  caption?: string;
  headers: string[];
  rows: string[][];
};

/**
 * A single action block. Strings may contain {{placeholder}} tokens that
 * the renderer substitutes from the signal's context map.
 */
export type ActionBlock = {
  id: ActionId;
  /** Short title shown as the section heading. Sentence case. */
  title: string;
  /** Optional emphasis pill rendered next to the title. */
  emphasis?: ActionEmphasis;
  /** First paragraph after the title. */
  intro?: string;
  /** Bulleted recommendations. */
  bullets?: string[];
  /** Optional table (e.g. promotional offer prices). */
  table?: ActionTable;
  /** Closing paragraph or call-to-action. */
  closing?: string;
};

/** A vertical's playbook is a partial map — missing IDs fall back to default. */
export type Playbook = Partial<Record<ActionId, ActionBlock>>;
