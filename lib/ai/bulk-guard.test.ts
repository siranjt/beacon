/**
 * Tests for the per-turn bulk-action guard. SMOKE-FIX 2.
 *
 * The guard's job is to refuse genuine multi-CUSTOMER bulk actions ("draft
 * emails to A, B, C") while allowing multi-TOOL-for-one-customer asks
 * ("how engaged are they + how are reviews trending?" → two reads against
 * the same entity_id, both fire).
 *
 * extractEntityIdFromToolInput must normalize across the three identifier
 * shapes the tool registry uses (entity_id / customer_id / cb_customer_id)
 * and return null for tools that don't take any of them (lookup,
 * query_customer_book, query_brain).
 *
 * shouldAllowToolUse must:
 *   - allow scopeless calls unconditionally,
 *   - allow the first scoped call of a turn,
 *   - allow subsequent calls on the same customer,
 *   - refuse calls on a different customer.
 */

import { describe, it, expect } from "vitest";
import {
  extractEntityIdFromToolInput,
  shouldAllowToolUse,
} from "./bulk-guard";

describe("extractEntityIdFromToolInput", () => {
  it("returns the entity_id when the tool input carries one", () => {
    expect(
      extractEntityIdFromToolInput({ entity_id: "abc-123", window_days: 30 }),
    ).toBe("abc-123");
  });

  it("returns the customer_id when the tool uses that argument name", () => {
    expect(
      extractEntityIdFromToolInput({
        customer_id: "ent-456",
        bizname: "Acme",
        days: 7,
      }),
    ).toBe("ent-456");
  });

  it("returns the cb_customer_id when neither entity_id nor customer_id is set", () => {
    expect(
      extractEntityIdFromToolInput({ cb_customer_id: "cb_789" }),
    ).toBe("cb_789");
  });

  it("prefers entity_id when multiple identifier fields are present", () => {
    // Defensive — shouldn't happen in practice, but if a tool ever set both,
    // the canonical entity_id wins.
    expect(
      extractEntityIdFromToolInput({
        entity_id: "ent-primary",
        customer_id: "cust-secondary",
      }),
    ).toBe("ent-primary");
  });

  it("returns null for scopeless tool inputs (lookup, query_customer_book, query_brain)", () => {
    expect(
      extractEntityIdFromToolInput({ query: "Acme Salon" }),
    ).toBeNull();
    expect(
      extractEntityIdFromToolInput({
        metric: "mrr",
        group_by: "tier",
        buckets: { type: "sum" },
      }),
    ).toBeNull();
    expect(
      extractEntityIdFromToolInput({ topic_subcategory: "platform" }),
    ).toBeNull();
  });

  it("returns null for empty / non-string identifier values", () => {
    expect(extractEntityIdFromToolInput({ entity_id: "" })).toBeNull();
    expect(extractEntityIdFromToolInput({ entity_id: "   " })).toBeNull();
    expect(extractEntityIdFromToolInput({ entity_id: 12345 })).toBeNull();
    expect(extractEntityIdFromToolInput({ entity_id: null })).toBeNull();
  });

  it("returns null for non-object inputs", () => {
    expect(extractEntityIdFromToolInput(null)).toBeNull();
    expect(extractEntityIdFromToolInput(undefined)).toBeNull();
    expect(extractEntityIdFromToolInput("ent-123")).toBeNull();
    expect(extractEntityIdFromToolInput(42)).toBeNull();
  });

  it("trims whitespace around identifier values", () => {
    expect(
      extractEntityIdFromToolInput({ entity_id: "  abc-123  " }),
    ).toBe("abc-123");
  });
});

describe("shouldAllowToolUse", () => {
  it("allows a single tool call on one customer (trivial)", () => {
    const seen = new Set<string>();
    expect(shouldAllowToolUse(seen, "ent-1")).toBe(true);
  });

  it("allows two tool calls on the SAME entity_id in the same turn", () => {
    // This is the legitimate multi-metric case from the smoke test:
    // "how engaged are they + how are reviews trending?" → both tools fire
    // against the same customer.
    const seen = new Set<string>();
    expect(shouldAllowToolUse(seen, "ent-1")).toBe(true);
    seen.add("ent-1");
    expect(shouldAllowToolUse(seen, "ent-1")).toBe(true);
  });

  it("REFUSES tool calls targeting DIFFERENT entity_ids in one turn", () => {
    // This is the genuine bulk-action case the guard is built for:
    // "draft emails to A, B, and C" — the second customer must be dropped.
    const seen = new Set<string>(["ent-A"]);
    expect(shouldAllowToolUse(seen, "ent-B")).toBe(false);
  });

  it("allows scopeless calls (lookup_customer, query_*) regardless of state", () => {
    // Scopeless tools don't lock the turn to any customer — they're
    // enabling reads.
    expect(shouldAllowToolUse(new Set(), null)).toBe(true);
    expect(shouldAllowToolUse(new Set(["ent-1"]), null)).toBe(true);
    expect(shouldAllowToolUse(new Set(["ent-1", "ent-2"]), null)).toBe(true);
  });

  it("allows three tools chained on one customer (read + read + act)", () => {
    // Common workflow: read_customer_brain → read_customer_notes →
    // add_note, all on the same entity_id.
    const seen = new Set<string>();
    expect(shouldAllowToolUse(seen, "ent-1")).toBe(true);
    seen.add("ent-1");
    expect(shouldAllowToolUse(seen, "ent-1")).toBe(true);
    expect(shouldAllowToolUse(seen, "ent-1")).toBe(true);
  });

  it("allows mixed scopeless + scoped on one customer", () => {
    // lookup_customer (scopeless) → get_chargebee_billing (scoped) →
    // get_customer_performance (scoped, same customer) — all should fire.
    const seen = new Set<string>();
    expect(shouldAllowToolUse(seen, null)).toBe(true); // lookup
    expect(shouldAllowToolUse(seen, "ent-1")).toBe(true); // billing
    seen.add("ent-1");
    expect(shouldAllowToolUse(seen, "ent-1")).toBe(true); // performance
  });
});
