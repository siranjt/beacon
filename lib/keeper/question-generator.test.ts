/**
 * WAVE-B Keeper Question Bank — generator tests.
 *
 * Verifies the contract with Haiku at the module boundary:
 *   1. A clean cluster maps to a valid {question, confidence} object
 *   2. The prompt actually carries every supplied gap description
 *   3. Explicit null from Haiku returns null (cluster too dispersed)
 *   4. Garbled / non-JSON output returns null (no crash, no half-row)
 *   5. Missing ANTHROPIC_API_KEY soft-fails to null
 *
 * Anthropic SDK is mocked at the module boundary so tests run offline.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

interface MockMessage {
  content: Array<{ type: "text"; text: string }>;
}

type MockResponseQueue = Array<MockMessage | { _throw: Error }>;

const __queue: MockResponseQueue = [];
const __lastCallArgs: Array<Record<string, unknown>> = [];

function __setMockResponse(payload: string | Error) {
  if (payload instanceof Error) {
    __queue.push({ _throw: payload });
  } else {
    __queue.push({ content: [{ type: "text", text: payload }] });
  }
}

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn(async (args: Record<string, unknown>) => {
          __lastCallArgs.push(args);
          const next = __queue.shift();
          if (!next) return { content: [{ type: "text", text: "" }] };
          if ("_throw" in next) throw next._throw;
          return next;
        }),
      };
    },
  };
});

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  __queue.length = 0;
  __lastCallArgs.length = 0;
});

describe("generateQuestion — happy path", () => {
  it("returns a structured {question, confidence} for a well-formed cluster", async () => {
    __setMockResponse(
      JSON.stringify({
        question: "Who is the primary decision-maker at Skin & Tonic, and what's their preferred contact channel?",
        confidence: "high",
      }),
    );
    const { generateQuestion } = await import("./question-generator");
    const out = await generateQuestion({
      descriptions: [
        "decision-maker undefined",
        "owner contact unclear",
        "preferred channel unknown",
      ],
      scope: "customer Skin & Tonic Facial Bar",
      category: "data_missing",
    });
    expect(out).not.toBeNull();
    expect(out!.question).toMatch(/decision-maker|channel/i);
    expect(out!.confidence).toBe("high");
  });

  it("ships every gap description into the user prompt", async () => {
    __setMockResponse(
      JSON.stringify({ question: "Some question?", confidence: "medium" }),
    );
    const { generateQuestion } = await import("./question-generator");
    await generateQuestion({
      descriptions: ["alpha-gap", "beta-gap", "gamma-gap"],
      scope: "customer Acme",
      category: "data_missing",
    });
    expect(__lastCallArgs).toHaveLength(1);
    const args = __lastCallArgs[0] as { messages: Array<{ content: string }> };
    const userContent = args.messages[0].content;
    expect(userContent).toContain("alpha-gap");
    expect(userContent).toContain("beta-gap");
    expect(userContent).toContain("gamma-gap");
    expect(userContent).toContain("customer Acme");
    expect(userContent).toContain("data_missing");
  });
});

describe("generateQuestion — null / refusal handling", () => {
  it("returns null when Haiku says the gaps don't share a question", async () => {
    __setMockResponse(JSON.stringify({ question: null, confidence: "low" }));
    const { generateQuestion } = await import("./question-generator");
    const out = await generateQuestion({
      descriptions: ["a", "b", "c"],
      scope: "customer Foo",
      category: "data_missing",
    });
    expect(out).toBeNull();
  });

  it("returns null on garbled non-JSON output (no half-row)", async () => {
    __setMockResponse("yeah I dunno here are some thoughts");
    const { generateQuestion } = await import("./question-generator");
    const out = await generateQuestion({
      descriptions: ["a", "b", "c"],
      scope: "customer Foo",
      category: "data_missing",
    });
    expect(out).toBeNull();
  });

  it("downgrades unknown confidence values to 'medium'", async () => {
    __setMockResponse(
      JSON.stringify({ question: "Is there a question here?", confidence: "wat" }),
    );
    const { generateQuestion } = await import("./question-generator");
    const out = await generateQuestion({
      descriptions: ["a", "b", "c"],
      scope: "customer Foo",
      category: "data_missing",
    });
    expect(out).not.toBeNull();
    expect(out!.confidence).toBe("medium");
  });

  it("soft-fails to null when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { generateQuestion } = await import("./question-generator");
    const out = await generateQuestion({
      descriptions: ["a", "b", "c"],
      scope: "customer Foo",
      category: "data_missing",
    });
    expect(out).toBeNull();
  });
});
