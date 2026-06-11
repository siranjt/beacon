/**
 * ActionCard state machine — single source of truth.
 *
 * Why this file exists: on 2026-06-11 we shipped an auto-fire UX where every
 * Beam tool_use fires immediately on stream-in (commit e375773). The auto-fire
 * path set the initial entry status to "approving" so the Discard/Approve
 * buttons would never render. But the `resolveToolUse` callback in AskPanel
 * had its own status guard that bailed unless status === "pending". The two
 * places drifted, the POST never fired, and the "Fetching the details…" pill
 * spun forever (commit 5b6048c was the hotfix).
 *
 * To prevent this from happening again: the producer (auto-fire setter) and
 * consumer (resolveToolUse guard) BOTH import from this file. The list of
 * statuses that can transition forward is one constant. If anyone adds or
 * removes a state without updating both call sites, the test in
 * action-state.test.ts fails, and typecheck catches dead branches.
 *
 * State machine:
 *   pending    → user-click path (legacy, kept in case approval comes back)
 *   approving  → auto-fire path / mid-flight POST (current default for ALL tools)
 *   approved   → POST returned ok, summary/data rendered
 *   discarded  → user clicked Discard (legacy path)
 *   error      → POST threw
 *
 * Resolvable = "can transition forward to approved/error/discarded".
 * Terminal   = "no further transitions allowed".
 */

export type ActionCardStatus =
  | "pending"
  | "approving"
  | "approved"
  | "discarded"
  | "error";

/**
 * Statuses where calling `resolveToolUse(approve|discard)` is allowed to
 * proceed with the network round-trip. Both the auto-fire path (initial
 * status = "approving") and the legacy manual-click path (initial status =
 * "pending") fall through this gate.
 */
export const RESOLVABLE_STATUSES = ["pending", "approving"] as const satisfies readonly ActionCardStatus[];

/** Inverse — terminal states where re-resolution is a no-op. */
export const TERMINAL_STATUSES = ["approved", "discarded", "error"] as const satisfies readonly ActionCardStatus[];

/**
 * Type-narrowing helper. Returns true iff a tool_use entry with this status
 * can still transition forward (run the execute fetch, write the result,
 * etc.). Returns false for terminal states.
 *
 * Use this in EVERY guard that gates the resolveToolUse flow. Do NOT inline
 * `status === "pending"` or `status === "approving"` checks — that's how the
 * 2026-06-11 bug happened.
 */
export function isResolvable(status: ActionCardStatus): boolean {
  return (RESOLVABLE_STATUSES as readonly ActionCardStatus[]).includes(status);
}

/** Inverse of isResolvable. */
export function isTerminal(status: ActionCardStatus): boolean {
  return (TERMINAL_STATUSES as readonly ActionCardStatus[]).includes(status);
}
