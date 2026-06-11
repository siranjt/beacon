/**
 * Tests for two-stage tool routing — SMART-B2.
 *
 * The router asks Haiku which 1-3 tools the question needs, then trims the
 * candidate set Sonnet sees. We test the pure surface of `routeTools` with
 * `callHaikuJson` mocked — no real Anthropic calls, no Postgres.
 *
 * Asserts:
 *   - Clean JSON response → filtered candidates (preserves registry order).
 *   - Caps result at MAX_ROUTED_TOOLS (3).
 *   - Filters out tool names that aren't in the candidate registry.
 *   - Soft-fails to full candidate set on Haiku error / empty / non-array.
 *   - Skips routing entirely for short questions, small candidate sets,
 *     tool-continuation messages, and when env flag disables routing.
 *   - Cache returns prior decision on a repeat query.
 *   - Routing prompt contains every candidate tool name + a one-liner.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BeaconTool } from "@/lib/ai/tools";
import type { AiScope } from "@/lib/ai/scopes";

vi.mock("@/lib/customer/llm", () => ({
  callHaikuJson: vi.fn(),
}));

import { callHaikuJson } from "@/lib/customer/llm";
import {
  routeTools,
  buildRoutingPrompt,
  filterCandidatesByNames,
  shouldSkipRouting,
  _clearRoutingCacheForTest,
} from "./tool-router";

const mockHaiku = callHaikuJson as unknown as ReturnType<typeof vi.fn>;

/** Minimal tool builder — only the fields the router uses. */
function makeTool(name: string, description: string): BeaconTool {
  return {
    name,
    description,
    input_schema: { type: "object", properties: {} } as BeaconTool["input_schema"],
    execute: async () => ({ ok: true, summary: "noop" }),
  };
}

const SCOPE: AiScope = { kind: "customer-360", entityId: "ent-1" };

/** A 5-tool candidate set — large enough to trigger routing. */
function makeFiveCandidates(): BeaconTool[] {
  return [
    makeTool("lookup_customer", "Find a customer by name or email."),
    makeTool("read_customer_brain", "Read curated Keeper facts for one customer."),
    makeTool("get_customer_performance", "Pull GBP / SEO / leads metrics for one customer."),
    makeTool("draft_email_to_contact", "Generate an email draft in the AM voice."),
    makeTool("draft_slack_message", "Draft an internal Slack message."),
  ];
}

beforeEach(() => {
  mockHaiku.mockReset();
  _clearRoutingCacheForTest();
  delete process.env.BEAM_TOOL_ROUTING_DISABLED;
});

describe("filterCandidatesByNames", () => {
  it("returns intersection of candidates and names, preserving candidate order", () => {
    const cands = makeFiveCandidates();
    const out = filterCandidatesByNames(cands, [
      "draft_email_to_contact",
      "lookup_customer",
    ]);
    expect(out.map((t) => t.name)).toEqual([
      "lookup_customer",
      "draft_email_to_contact",
    ]);
  });

  it("caps result at 3 tools even if Haiku names more", () => {
    const cands = makeFiveCandidates();
    const out = filterCandidatesByNames(cands, [
      "lookup_customer",
      "read_customer_brain",
      "get_customer_performance",
      "draft_email_to_contact",
      "draft_slack_message",
    ]);
    expect(out.length).toBe(3);
  });

  it("filters out names not in the registry", () => {
    const cands = makeFiveCandidates();
    const out = filterCandidatesByNames(cands, [
      "lookup_customer",
      "totally_made_up_tool",
      "another_fake",
    ]);
    expect(out.map((t) => t.name)).toEqual(["lookup_customer"]);
  });

  it("dedupes repeated names", () => {
    const cands = makeFiveCandidates();
    const out = filterCandidatesByNames(cands, [
      "lookup_customer",
      "lookup_customer",
      "lookup_customer",
    ]);
    expect(out.length).toBe(1);
  });
});

describe("shouldSkipRouting", () => {
  it("skips when env flag is set", () => {
    process.env.BEAM_TOOL_ROUTING_DISABLED = "true";
    const r = shouldSkipRouting("what is on this account", makeFiveCandidates());
    expect(r).toEqual({ skip: true, reason: "env_disabled" });
  });

  it("skips empty / very short questions", () => {
    const r = shouldSkipRouting("hi", makeFiveCandidates());
    expect(r).toEqual({ skip: true, reason: "question_not_routable" });
  });

  it("skips tool-continuation synthetic messages", () => {
    const r = shouldSkipRouting(
      "[Beacon ran read_customer_brain — here are the facts]",
      makeFiveCandidates(),
    );
    expect(r).toEqual({ skip: true, reason: "question_not_routable" });
  });

  it("skips when candidate set already ≤ 3", () => {
    const small = makeFiveCandidates().slice(0, 3);
    const r = shouldSkipRouting("what platform are they on", small);
    expect(r).toEqual({ skip: true, reason: "candidate_set_already_small" });
  });

  it("routes otherwise", () => {
    const r = shouldSkipRouting(
      "what platform are they on",
      makeFiveCandidates(),
    );
    expect(r).toEqual({ skip: false });
  });
});

describe("buildRoutingPrompt", () => {
  it("includes every candidate tool by name + a one-liner", () => {
    const prompt = buildRoutingPrompt(
      "what platform is acme on",
      makeFiveCandidates(),
    );
    for (const t of makeFiveCandidates()) {
      expect(prompt).toContain(`- ${t.name}: `);
    }
    expect(prompt).toContain("what platform is acme on");
    expect(prompt).toContain("JSON array");
  });

  it("strips multi-line descriptions to a single line", () => {
    const cands = [
      makeTool(
        "multi_line_tool",
        "first line summary\nsecond line drilling into args\nthird line examples",
      ),
      makeTool("other", "other purpose"),
      makeTool("third", "third purpose"),
      makeTool("fourth", "fourth purpose"),
    ];
    const prompt = buildRoutingPrompt("test", cands);
    expect(prompt).toContain("multi_line_tool: first line summary");
    expect(prompt).not.toContain("second line drilling");
  });
});

describe("routeTools — soft-fail behaviour", () => {
  it("returns full candidate set when Haiku rejects (empty array)", async () => {
    mockHaiku.mockResolvedValueOnce([]);
    const cands = makeFiveCandidates();
    const decision = await routeTools(SCOPE, "what platform are they on", cands);
    expect(decision.tools).toEqual(cands);
    expect(decision.routed).toBe(false);
    expect(decision.skipReason).toBe("haiku_no_decision");
  });

  it("returns full candidate set when Haiku returns non-array garbage", async () => {
    mockHaiku.mockResolvedValueOnce({ unexpected: "shape" });
    const cands = makeFiveCandidates();
    const decision = await routeTools(SCOPE, "what platform are they on", cands);
    expect(decision.tools).toEqual(cands);
    expect(decision.routed).toBe(false);
  });

  it("returns full candidate set when Haiku throws", async () => {
    mockHaiku.mockRejectedValueOnce(new Error("network down"));
    const cands = makeFiveCandidates();
    const decision = await routeTools(SCOPE, "what platform are they on", cands);
    expect(decision.tools).toEqual(cands);
    expect(decision.routed).toBe(false);
  });

  it("returns full candidate set when every Haiku-named tool is invalid", async () => {
    mockHaiku.mockResolvedValueOnce(["not_a_tool", "also_fake"]);
    const cands = makeFiveCandidates();
    const decision = await routeTools(SCOPE, "what platform are they on", cands);
    expect(decision.tools).toEqual(cands);
    expect(decision.routed).toBe(false);
  });
});

describe("routeTools — happy path", () => {
  it("parses clean JSON array of tool names and trims the candidate set", async () => {
    mockHaiku.mockResolvedValueOnce(["read_customer_brain"]);
    const cands = makeFiveCandidates();
    const decision = await routeTools(
      SCOPE,
      "what platform is this customer on",
      cands,
    );
    expect(decision.tools.map((t) => t.name)).toEqual(["read_customer_brain"]);
    expect(decision.routed).toBe(true);
    expect(decision.candidateCount).toBe(5);
    expect(decision.cacheHit).toBe(false);
  });

  it("accepts the {tools: [...]} object form", async () => {
    mockHaiku.mockResolvedValueOnce({
      tools: ["lookup_customer", "draft_email_to_contact"],
    });
    const cands = makeFiveCandidates();
    const decision = await routeTools(
      SCOPE,
      "draft an email to acme",
      cands,
    );
    expect(decision.tools.map((t) => t.name)).toEqual([
      "lookup_customer",
      "draft_email_to_contact",
    ]);
    expect(decision.routed).toBe(true);
  });

  it("caps at 3 tools even when Haiku names more", async () => {
    mockHaiku.mockResolvedValueOnce([
      "lookup_customer",
      "read_customer_brain",
      "get_customer_performance",
      "draft_email_to_contact",
      "draft_slack_message",
    ]);
    const cands = makeFiveCandidates();
    const decision = await routeTools(SCOPE, "do everything", cands);
    expect(decision.tools.length).toBe(3);
    expect(decision.routed).toBe(true);
  });
});

describe("routeTools — skip semantics", () => {
  it("skips routing when BEAM_TOOL_ROUTING_DISABLED=true", async () => {
    process.env.BEAM_TOOL_ROUTING_DISABLED = "true";
    const cands = makeFiveCandidates();
    const decision = await routeTools(SCOPE, "what platform are they on", cands);
    expect(decision.tools).toEqual(cands);
    expect(decision.routed).toBe(false);
    expect(decision.skipReason).toBe("env_disabled");
    expect(mockHaiku).not.toHaveBeenCalled();
  });

  it("skips routing when candidate set ≤ 3 (inbox-style)", async () => {
    const inboxCands = makeFiveCandidates().slice(0, 2);
    const decision = await routeTools(SCOPE, "what's in my inbox", inboxCands);
    expect(decision.tools).toEqual(inboxCands);
    expect(decision.routed).toBe(false);
    expect(decision.skipReason).toBe("candidate_set_already_small");
    expect(mockHaiku).not.toHaveBeenCalled();
  });

  it("skips routing for tool-continuation messages", async () => {
    const cands = makeFiveCandidates();
    const decision = await routeTools(
      SCOPE,
      "[Beacon ran read_customer_brain — here are 5 facts]",
      cands,
    );
    expect(decision.tools).toEqual(cands);
    expect(decision.routed).toBe(false);
    expect(mockHaiku).not.toHaveBeenCalled();
  });

  it("skips routing for very short questions", async () => {
    const cands = makeFiveCandidates();
    const decision = await routeTools(SCOPE, "hi", cands);
    expect(decision.routed).toBe(false);
    expect(mockHaiku).not.toHaveBeenCalled();
  });
});

describe("routeTools — caching", () => {
  it("returns cached decision on a repeat (scope, question, candidates) tuple", async () => {
    mockHaiku.mockResolvedValueOnce(["read_customer_brain"]);
    const cands = makeFiveCandidates();
    const first = await routeTools(
      SCOPE,
      "what platform are they on",
      cands,
    );
    expect(first.cacheHit).toBe(false);
    expect(mockHaiku).toHaveBeenCalledTimes(1);

    const second = await routeTools(
      SCOPE,
      "what platform are they on",
      cands,
    );
    expect(second.cacheHit).toBe(true);
    expect(second.tools.map((t) => t.name)).toEqual(["read_customer_brain"]);
    // Haiku should NOT have been called again.
    expect(mockHaiku).toHaveBeenCalledTimes(1);
  });

  it("different questions miss the cache and trigger a new Haiku call", async () => {
    mockHaiku
      .mockResolvedValueOnce(["read_customer_brain"])
      .mockResolvedValueOnce(["draft_email_to_contact"]);
    const cands = makeFiveCandidates();
    const a = await routeTools(SCOPE, "what platform are they on", cands);
    const b = await routeTools(SCOPE, "draft an email to acme", cands);
    expect(a.tools.map((t) => t.name)).toEqual(["read_customer_brain"]);
    expect(b.tools.map((t) => t.name)).toEqual(["draft_email_to_contact"]);
    expect(mockHaiku).toHaveBeenCalledTimes(2);
  });
});
