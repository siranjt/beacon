/**
 * Phase E-13 — first tests, target #1: pathToScope.
 *
 * pathToScope is called on EVERY render of EVERY page (it lives in
 * AskPanel's useEffect via usePathname). A bug here would either misroute
 * an AM's question to the wrong context, or hide the panel entirely. Both
 * are catastrophic for the copilot's usability — exactly the class of
 * regression these tests should catch before the next deploy.
 *
 * Coverage strategy: assert each scope kind is reachable from at least
 * one representative path, plus the negative path (hidden routes), plus
 * the order-of-precedence cases that ordering bugs would silently break.
 */

import { describe, it, expect } from "vitest";
import {
  pathToScope,
  scopeKey,
  scopeLabel,
  scopeQuickPrompts,
  type AiScope,
} from "./scopes";

describe("pathToScope — hidden routes", () => {
  it("hides on /auth/signin", () => {
    expect(pathToScope("/auth/signin")).toEqual({ kind: "hidden" });
  });

  it("hides on /auth/signout", () => {
    expect(pathToScope("/auth/signout")).toEqual({ kind: "hidden" });
  });

  it("hides on /admin/activity-log", () => {
    expect(pathToScope("/admin/activity-log")).toEqual({ kind: "hidden" });
  });

  it("hides on /api routes (panel never renders against APIs)", () => {
    expect(pathToScope("/api/ai/ask")).toEqual({ kind: "hidden" });
    expect(pathToScope("/api/v2/snapshot")).toEqual({ kind: "hidden" });
  });

  it("hides on unknown / unmounted routes", () => {
    expect(pathToScope("/foo/bar")).toEqual({ kind: "hidden" });
    expect(pathToScope("/garbage")).toEqual({ kind: "hidden" });
  });
});

describe("pathToScope — Customer Beacon", () => {
  it("resolves /customer to customer-book", () => {
    expect(pathToScope("/customer")).toEqual({ kind: "customer-book" });
  });

  it("resolves /customer/manager/* to customer-book", () => {
    expect(pathToScope("/customer/manager")).toEqual({ kind: "customer-book" });
    expect(pathToScope("/customer/manager/sudha")).toEqual({
      kind: "customer-book",
    });
  });

  it("resolves /customer/monday to customer-book", () => {
    expect(pathToScope("/customer/monday")).toEqual({ kind: "customer-book" });
  });

  it("treats /customer/{entityId} as customer-360 (same AI grounding)", () => {
    const r = pathToScope("/customer/abc123-entity-uuid");
    expect(r).toEqual({
      kind: "customer-360",
      entityId: "abc123-entity-uuid",
    });
  });

  it("does NOT confuse 'manager' or 'monday' as entity_ids", () => {
    // Regression guard: a naive regex match would treat these as entity ids.
    expect(pathToScope("/customer/manager").kind).toBe("customer-book");
    expect(pathToScope("/customer/monday").kind).toBe("customer-book");
  });
});

describe("pathToScope — Customer 360 (umbrella unified view)", () => {
  it("resolves /360/{entityId} to customer-360", () => {
    const r = pathToScope("/360/some-entity-uuid");
    expect(r).toEqual({ kind: "customer-360", entityId: "some-entity-uuid" });
  });

  it("preserves entity_id with hyphens", () => {
    const r = pathToScope("/360/d3b07384-d113-4ca9-8b76-1a2b3c4d5e6f");
    expect(r).toEqual({
      kind: "customer-360",
      entityId: "d3b07384-d113-4ca9-8b76-1a2b3c4d5e6f",
    });
  });

  it("matches even with trailing slashes / nested paths", () => {
    // Used by deep-linking from inbox/command palette.
    const r = pathToScope("/360/abc/timeline");
    expect(r).toEqual({ kind: "customer-360", entityId: "abc" });
  });
});

describe("pathToScope — Performance Beacon", () => {
  it("resolves /performance to performance-landing", () => {
    expect(pathToScope("/performance")).toEqual({
      kind: "performance-landing",
    });
  });

  it("resolves /performance/something-else to landing", () => {
    expect(pathToScope("/performance/recent")).toEqual({
      kind: "performance-landing",
    });
  });

  it("resolves /performance/report/{entityId} to performance-report", () => {
    expect(pathToScope("/performance/report/xyz789")).toEqual({
      kind: "performance-report",
      entityId: "xyz789",
    });
  });

  it("performance-report wins over performance-landing (specificity)", () => {
    // Regression guard: if the report check moved below the landing check,
    // it would silently fall through to landing.
    expect(pathToScope("/performance/report/abc").kind).toBe(
      "performance-report",
    );
  });
});

describe("pathToScope — Escalation Beacon", () => {
  it("resolves /escalation to escalation-overview", () => {
    expect(pathToScope("/escalation")).toEqual({ kind: "escalation-overview" });
  });

  it("treats any /escalation/* subpage as the same scope (queue/triage/tickets unified)", () => {
    expect(pathToScope("/escalation/queue").kind).toBe("escalation-overview");
    expect(pathToScope("/escalation/triage/abc").kind).toBe(
      "escalation-overview",
    );
    expect(pathToScope("/escalation/tickets").kind).toBe("escalation-overview");
  });
});

describe("pathToScope — Post-Payment Reviews", () => {
  it("resolves /post-payment to post-payment-book", () => {
    expect(pathToScope("/post-payment")).toEqual({ kind: "post-payment-book" });
  });

  it("resolves /post-payment/reports/{cbCustomerId} to post-payment-customer", () => {
    expect(pathToScope("/post-payment/reports/cb_abc123")).toEqual({
      kind: "post-payment-customer",
      cbCustomerId: "cb_abc123",
    });
  });

  it("post-payment-customer wins over post-payment-book (specificity)", () => {
    // Regression guard for the same precedence bug as performance above.
    expect(pathToScope("/post-payment/reports/cb_xxx").kind).toBe(
      "post-payment-customer",
    );
  });
});

describe("pathToScope — umbrella launcher (inbox)", () => {
  it("resolves / to inbox", () => {
    expect(pathToScope("/")).toEqual({ kind: "inbox" });
  });

  it("resolves empty string to inbox (defensive)", () => {
    expect(pathToScope("")).toEqual({ kind: "inbox" });
  });
});

describe("scopeKey — stable string keys for analytics + storage", () => {
  it("returns just the kind for non-parametrized scopes", () => {
    expect(scopeKey({ kind: "inbox" })).toBe("inbox");
    expect(scopeKey({ kind: "customer-book" })).toBe("customer-book");
    expect(scopeKey({ kind: "performance-landing" })).toBe(
      "performance-landing",
    );
    expect(scopeKey({ kind: "escalation-overview" })).toBe(
      "escalation-overview",
    );
    expect(scopeKey({ kind: "post-payment-book" })).toBe("post-payment-book");
    expect(scopeKey({ kind: "hidden" })).toBe("hidden");
  });

  it("embeds entity_id for customer-360", () => {
    expect(
      scopeKey({ kind: "customer-360", entityId: "abc-123" }),
    ).toBe("customer-360:abc-123");
  });

  it("embeds entity_id for performance-report", () => {
    expect(
      scopeKey({ kind: "performance-report", entityId: "xyz-789" }),
    ).toBe("performance-report:xyz-789");
  });

  it("embeds cb_customer_id for post-payment-customer", () => {
    expect(
      scopeKey({
        kind: "post-payment-customer",
        cbCustomerId: "cb_abc",
      }),
    ).toBe("post-payment-customer:cb_abc");
  });
});

describe("scopeLabel — every scope has a human label", () => {
  const allScopes: AiScope[] = [
    { kind: "inbox" },
    { kind: "customer-360", entityId: "x" },
    { kind: "customer-book" },
    { kind: "performance-landing" },
    { kind: "performance-report", entityId: "x" },
    { kind: "escalation-overview" },
    { kind: "post-payment-book" },
    { kind: "post-payment-customer", cbCustomerId: "x" },
    { kind: "hidden" },
  ];

  it("returns a non-empty string for every non-hidden scope", () => {
    for (const s of allScopes) {
      const label = scopeLabel(s);
      if (s.kind === "hidden") {
        expect(label).toBe("");
      } else {
        expect(label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("scopeQuickPrompts — every visible scope has at least 2 prompts", () => {
  // Guard against accidentally shipping an empty quick-prompts list, which
  // would render an awkward gap in the AskPanel empty state.
  const visibleScopes: AiScope[] = [
    { kind: "inbox" },
    { kind: "customer-360", entityId: "x" },
    { kind: "customer-book" },
    { kind: "performance-landing" },
    { kind: "performance-report", entityId: "x" },
    { kind: "escalation-overview" },
    { kind: "post-payment-book" },
    { kind: "post-payment-customer", cbCustomerId: "x" },
  ];

  it("each visible scope returns ≥ 2 prompts", () => {
    for (const s of visibleScopes) {
      const prompts = scopeQuickPrompts(s);
      expect(prompts.length, `scope ${s.kind} should have ≥ 2 prompts`).toBeGreaterThanOrEqual(2);
    }
  });

  it("each prompt has a non-empty label + non-empty prompt body", () => {
    for (const s of visibleScopes) {
      for (const p of scopeQuickPrompts(s)) {
        expect(p.label.length).toBeGreaterThan(0);
        expect(p.prompt.length).toBeGreaterThan(10);
      }
    }
  });

  it("hidden scope returns empty list", () => {
    expect(scopeQuickPrompts({ kind: "hidden" })).toEqual([]);
  });
});
