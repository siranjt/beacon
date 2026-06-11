import { describe, it, expect } from "vitest";
import {
  RESOLVABLE_STATUSES,
  TERMINAL_STATUSES,
  isResolvable,
  isTerminal,
  type ActionCardStatus,
} from "./action-state";

/**
 * Regression test for the 2026-06-11 "Fetching the details…" hang bug.
 *
 * Background: auto-fire commit e375773 set the initial ActionCard status to
 * "approving" so the Discard/Approve buttons would never render. But
 * resolveToolUse had a strict `status === "pending"` guard that bailed before
 * the POST. The tool execute fetch never fired and the pill spun forever.
 *
 * This test exists to make sure the producer (auto-fire setter in AskPanel)
 * and the consumer (resolveToolUse guard in AskPanel) never drift again. If
 * someone removes "pending" or "approving" from RESOLVABLE_STATUSES without
 * also fixing every call site, this test fails loud.
 *
 * The corresponding code change is in components/ai/AskPanel.tsx — both
 * guards call isResolvable(status) instead of inlining the comparison.
 */
describe("action-state — resolvable transition gate", () => {
  it("treats 'pending' as resolvable (legacy manual-click path)", () => {
    expect(isResolvable("pending")).toBe(true);
  });

  it("treats 'approving' as resolvable (auto-fire default path)", () => {
    expect(isResolvable("approving")).toBe(true);
  });

  it("treats 'approved' as terminal — no re-resolution", () => {
    expect(isResolvable("approved")).toBe(false);
    expect(isTerminal("approved")).toBe(true);
  });

  it("treats 'discarded' as terminal — no re-resolution", () => {
    expect(isResolvable("discarded")).toBe(false);
    expect(isTerminal("discarded")).toBe(true);
  });

  it("treats 'error' as terminal — no re-resolution", () => {
    expect(isResolvable("error")).toBe(false);
    expect(isTerminal("error")).toBe(true);
  });

  it("RESOLVABLE and TERMINAL partition the full status set exactly", () => {
    const all = new Set<ActionCardStatus>([
      ...RESOLVABLE_STATUSES,
      ...TERMINAL_STATUSES,
    ]);
    const allKnown: ActionCardStatus[] = [
      "pending",
      "approving",
      "approved",
      "discarded",
      "error",
    ];
    expect(all.size).toBe(allKnown.length);
    for (const s of allKnown) {
      expect(all.has(s)).toBe(true);
      // exactly one of the two groups
      expect(isResolvable(s) !== isTerminal(s)).toBe(true);
    }
  });

  it("REGRESSION GUARD — auto-fire's initial status must remain resolvable", () => {
    // If you ever change the auto-fire default in AskPanel.tsx, update both
    // sides at once. This test exists because we shipped a hang when only
    // one side moved.
    const autoFireInitialStatus: ActionCardStatus = "approving";
    expect(isResolvable(autoFireInitialStatus)).toBe(true);
  });
});
