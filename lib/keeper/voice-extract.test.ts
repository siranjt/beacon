/**
 * voice-extract tests — Wave C.
 *
 * Goal: lock down the extractor's contract — clean transcripts produce a
 * structured draft, garbled/empty input soft-fails to unparseable, PII gets
 * no special treatment (just classified like anything else).
 *
 * Anthropic SDK is mocked at the module boundary so tests run offline. The
 * mock honors the order tests register responses via __setMockResponse so
 * we can drive multiple Haiku turns from a single suite.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

interface MockMessage {
  content: Array<{ type: "text"; text: string }>;
}

type MockResponseQueue = Array<MockMessage | { _throw: Error }>;

const __queue: MockResponseQueue = [];

function __setMockResponse(payload: string | Error) {
  if (payload instanceof Error) {
    __queue.push({ _throw: payload });
  } else {
    __queue.push({ content: [{ type: "text", text: payload }] });
  }
}

// Mock the Anthropic SDK before the module imports it. The factory shape
// matches `new Anthropic({...}).messages.create(...)`.
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn(async () => {
          const next = __queue.shift();
          if (!next) {
            return { content: [{ type: "text", text: "" }] };
          }
          if ("_throw" in next) throw next._throw;
          return next;
        }),
      };
    },
  };
});

// Force the env key so the soft-fail "anthropic_api_key_missing" branch
// doesn't short-circuit our tests that actually want to drive Haiku.
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  __queue.length = 0;
});

describe("extractFactFromTranscript — clean transcript", () => {
  it("classifies 'owner is Sarah, prefers WhatsApp' into a valid draft", async () => {
    __setMockResponse(
      JSON.stringify({
        topic_category: "behavioral",
        topic_subcategory: "comms_preference",
        field_name: "preferred_channel",
        value: "WhatsApp",
        confidence: "high",
      }),
    );
    const { extractFactFromTranscript } = await import("./voice-extract");
    const result = await extractFactFromTranscript(
      "Owner is Sarah, and she prefers WhatsApp over email for everything.",
      { bizname: "Sarah's Salon" },
    );

    expect(result.unparseable).toBeFalsy();
    if (result.unparseable) return; // type narrow
    expect(result.topic_category).toBe("behavioral");
    expect(result.topic_subcategory).toBe("comms_preference");
    expect(result.field_name).toBe("preferred_channel");
    expect(result.value).toBe("WhatsApp");
    expect(result.confidence).toBe("high");
  });

  it("strips markdown code fences from the model's response", async () => {
    __setMockResponse(
      "```json\n" +
        JSON.stringify({
          topic_category: "identity",
          topic_subcategory: "owner_info",
          field_name: "owner_name",
          value: "Sarah Lee",
          confidence: "high",
        }) +
        "\n```",
    );
    const { extractFactFromTranscript } = await import("./voice-extract");
    const result = await extractFactFromTranscript(
      "The owner's name is Sarah Lee",
    );
    expect(result.unparseable).toBeFalsy();
    if (result.unparseable) return;
    expect(result.value).toBe("Sarah Lee");
  });
});

describe("extractFactFromTranscript — soft failures", () => {
  it("returns unparseable for transcript too short", async () => {
    const { extractFactFromTranscript } = await import("./voice-extract");
    const result = await extractFactFromTranscript("");
    expect(result.unparseable).toBe(true);
    if (!result.unparseable) return;
    expect(result.reason).toBe("transcript_too_short");
  });

  it("returns unparseable when Haiku says unparseable explicitly", async () => {
    __setMockResponse(
      JSON.stringify({ unparseable: true, reason: "no_fact_extractable" }),
    );
    const { extractFactFromTranscript } = await import("./voice-extract");
    const result = await extractFactFromTranscript(
      "uhhh um ok yeah whatever ok so",
    );
    expect(result.unparseable).toBe(true);
    if (!result.unparseable) return;
    expect(result.reason).toBe("no_fact_extractable");
  });

  it("returns unparseable when the model emits invalid JSON", async () => {
    __setMockResponse("this is definitely not JSON");
    const { extractFactFromTranscript } = await import("./voice-extract");
    const result = await extractFactFromTranscript(
      "some valid transcript here that the model fumbles on",
    );
    expect(result.unparseable).toBe(true);
    if (!result.unparseable) return;
    expect(result.reason).toBe("invalid_json");
  });

  it("returns unparseable when subcategory is bogus", async () => {
    __setMockResponse(
      JSON.stringify({
        topic_category: "identity",
        topic_subcategory: "not_a_real_subcategory",
        field_name: "owner_name",
        value: "Sarah",
        confidence: "high",
      }),
    );
    const { extractFactFromTranscript } = await import("./voice-extract");
    const result = await extractFactFromTranscript("owner is Sarah");
    expect(result.unparseable).toBe(true);
    if (!result.unparseable) return;
    expect(result.reason).toBe("unrecognized_shape");
  });
});

describe("extractFactFromTranscript — PII / passwords", () => {
  it("still parses to a fact when transcript contains a password — no special handling", async () => {
    __setMockResponse(
      JSON.stringify({
        topic_category: "operational",
        topic_subcategory: "integration",
        field_name: "other",
        value: "GBP login password is hunter2 (rotate immediately)",
        confidence: "medium",
      }),
    );
    const { extractFactFromTranscript } = await import("./voice-extract");
    const result = await extractFactFromTranscript(
      "Their GBP login password is hunter2 and we should rotate it immediately",
    );
    expect(result.unparseable).toBeFalsy();
    if (result.unparseable) return;
    // PII handling: NONE. We classify what was said. Validate inbox handles
    // review before anything writes to prod.
    expect(result.value).toContain("hunter2");
    expect(result.topic_subcategory).toBe("integration");
  });
});

describe("extractFactFromTranscript — defensive coercion", () => {
  it("coerces an unknown field_name to 'other' rather than rejecting outright", async () => {
    __setMockResponse(
      JSON.stringify({
        topic_category: "behavioral",
        topic_subcategory: "comms_preference",
        field_name: "totally_made_up_field",
        value: "Only responds after 6pm EST",
        confidence: "medium",
      }),
    );
    const { extractFactFromTranscript } = await import("./voice-extract");
    const result = await extractFactFromTranscript(
      "They only respond after 6pm EST",
    );
    expect(result.unparseable).toBeFalsy();
    if (result.unparseable) return;
    expect(result.field_name).toBe("other");
  });

  it("normalizes a junk confidence value to 'medium'", async () => {
    __setMockResponse(
      JSON.stringify({
        topic_category: "identity",
        topic_subcategory: "owner_info",
        field_name: "owner_name",
        value: "Sarah",
        confidence: "ultra-mega-high",
      }),
    );
    const { extractFactFromTranscript } = await import("./voice-extract");
    const result = await extractFactFromTranscript("owner is Sarah");
    expect(result.unparseable).toBeFalsy();
    if (result.unparseable) return;
    expect(result.confidence).toBe("medium");
  });
});
