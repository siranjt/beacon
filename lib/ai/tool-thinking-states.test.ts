/**
 * BEAM-THINKING (2026-06-13) — tool → loader-state mapping.
 *
 * Pinned so the Keeper tools always land on the vault lane and the
 * fallback never returns a blank label (the bug that motivated the
 * whole polish pass).
 */

import { describe, it, expect } from "vitest";
import { getBeamThinkingState } from "./tool-thinking-states";

describe("getBeamThinkingState", () => {
  it("routes the three Keeper tools to the vault lane", () => {
    expect(getBeamThinkingState("read_customer_brain").kind).toBe("vault");
    expect(getBeamThinkingState("query_brain").kind).toBe("vault");
    expect(getBeamThinkingState("add_fact_to_brain").kind).toBe("vault");
  });

  it("routes non-Keeper tools to the flame lane", () => {
    expect(getBeamThinkingState("get_chargebee_billing").kind).toBe("flame");
    expect(getBeamThinkingState("get_customer_performance").kind).toBe("flame");
    expect(getBeamThinkingState("draft_email_to_contact").kind).toBe("flame");
    expect(getBeamThinkingState("snooze_customer").kind).toBe("flame");
  });

  it("emits a verb-first label per tool (never blank, never raw tool name)", () => {
    const s = getBeamThinkingState("read_customer_brain");
    expect(s.label).toBe("Beam is opening the Keeper…");
    expect(s.label).not.toContain("read_customer_brain");
    expect(s.label).not.toBe("");
  });

  it("falls back to a flame + generic label for unknown tool names", () => {
    const s = getBeamThinkingState("totally_new_tool_we_havent_named");
    expect(s.kind).toBe("flame");
    expect(s.label).toBe("Beam is thinking…");
  });

  it("falls back gracefully for null / undefined / empty toolName", () => {
    expect(getBeamThinkingState(null).label).toBe("Beam is thinking…");
    expect(getBeamThinkingState(undefined).label).toBe("Beam is thinking…");
    expect(getBeamThinkingState("").label).toBe("Beam is thinking…");
  });
});
