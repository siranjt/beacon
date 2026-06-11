/**
 * Tests for the Beam tool registry — specifically the per-scope allowlist
 * (OPT-2). We assert:
 *   - Every allowlisted tool is a member of the canonical registry
 *     (i.e. allowlist entries can't drift to point at orphans).
 *   - Every scope's allowlist includes `lookup_customer` so Beam can always
 *     resolve a customer the surface didn't preload.
 *   - The allowlist is genuinely a *subset* per scope — no scope explodes
 *     past the registry by accident.
 *   - getToolsForScope falls back to the full registry for scopes not in
 *     the allowlist (backwards-compat invariant).
 *   - The registry itself is non-empty and tool names are unique.
 *   - All 10 active scopes (everything except "hidden") have an explicit
 *     entry so the allowlist is exhaustive in practice.
 *
 * These are static assertions over the registry, so no DB / Anthropic /
 * I/O is involved.
 */

import { describe, it, expect } from "vitest";
import {
  CUSTOMER_360_TOOLS,
  SCOPE_TOOL_ALLOWLIST,
  getToolsForScope,
} from "./index";
import type { AiScope } from "@/lib/ai/scopes";

const ALL_TOOL_NAMES = new Set(CUSTOMER_360_TOOLS.map((t) => t.name));

const ACTIVE_SCOPE_KINDS: AiScope["kind"][] = [
  "inbox",
  "customer-360",
  "customer-book",
  "performance-landing",
  "performance-report",
  "escalation-overview",
  "post-payment-book",
  "post-payment-customer",
  "miss-payment-overview",
  "negative-keyword-overview",
];

describe("SCOPE_TOOL_ALLOWLIST", () => {
  it("registry is non-empty and has unique tool names", () => {
    expect(CUSTOMER_360_TOOLS.length).toBeGreaterThan(0);
    const names = CUSTOMER_360_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every active scope has an explicit allowlist entry", () => {
    for (const k of ACTIVE_SCOPE_KINDS) {
      expect(SCOPE_TOOL_ALLOWLIST[k], `scope ${k} missing from allowlist`).toBeDefined();
    }
  });

  it.each(ACTIVE_SCOPE_KINDS)(
    "scope %s — every allowlisted tool is in the canonical registry",
    (kind) => {
      const tools = SCOPE_TOOL_ALLOWLIST[kind];
      expect(tools, `scope ${kind} has no allowlist`).toBeDefined();
      for (const t of tools!) {
        expect(ALL_TOOL_NAMES.has(t.name), `tool ${t.name} not in registry`).toBe(
          true,
        );
      }
    },
  );

  it.each(ACTIVE_SCOPE_KINDS)(
    "scope %s — allowlist is a subset of the full registry",
    (kind) => {
      const tools = SCOPE_TOOL_ALLOWLIST[kind]!;
      expect(tools.length).toBeLessThanOrEqual(CUSTOMER_360_TOOLS.length);
    },
  );

  it.each(ACTIVE_SCOPE_KINDS)(
    "scope %s — includes lookup_customer so Beam can always resolve a customer",
    (kind) => {
      const tools = SCOPE_TOOL_ALLOWLIST[kind]!;
      const names = tools.map((t) => t.name);
      expect(names).toContain("lookup_customer");
    },
  );

  it.each(ACTIVE_SCOPE_KINDS)(
    "scope %s — allowlist has no duplicate tool entries",
    (kind) => {
      const tools = SCOPE_TOOL_ALLOWLIST[kind]!;
      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    },
  );

  it("customer-360 keeps the mutator suite (snooze/pin/mark-contacted/add-note)", () => {
    const names = SCOPE_TOOL_ALLOWLIST["customer-360"]!.map((t) => t.name);
    expect(names).toContain("snooze_customer");
    expect(names).toContain("pin_customer");
    expect(names).toContain("mark_contacted_today");
    expect(names).toContain("add_note");
  });

  it("inbox stays lightweight (no mutators, no cross-book tools)", () => {
    const names = SCOPE_TOOL_ALLOWLIST["inbox"]!.map((t) => t.name);
    expect(names).not.toContain("snooze_customer");
    expect(names).not.toContain("pin_customer");
    expect(names).not.toContain("mark_contacted_today");
    expect(names).not.toContain("add_note");
    expect(names).not.toContain("query_customer_book");
    expect(names).not.toContain("query_brain");
  });

  it("manager cross-book tools land on the book scope, not customer-360", () => {
    const bookNames = SCOPE_TOOL_ALLOWLIST["customer-book"]!.map((t) => t.name);
    const c360Names = SCOPE_TOOL_ALLOWLIST["customer-360"]!.map((t) => t.name);
    expect(bookNames).toContain("query_customer_book");
    expect(bookNames).toContain("query_brain");
    expect(c360Names).not.toContain("query_customer_book");
    expect(c360Names).not.toContain("query_brain");
  });
});

describe("getToolsForScope", () => {
  it("returns the allowlist for scopes that have one", () => {
    const inboxTools = getToolsForScope("inbox");
    expect(inboxTools).toBe(SCOPE_TOOL_ALLOWLIST["inbox"]);
  });

  it("falls back to the full registry for scopes without an allowlist", () => {
    // "hidden" is intentionally not in the allowlist — exercise the fallback.
    const tools = getToolsForScope("hidden");
    expect(tools).toBe(CUSTOMER_360_TOOLS);
  });

  it("never returns a list with more tools than the registry", () => {
    for (const k of ACTIVE_SCOPE_KINDS) {
      expect(getToolsForScope(k).length).toBeLessThanOrEqual(
        CUSTOMER_360_TOOLS.length,
      );
    }
  });
});
