/**
 * Phase E-13 — first tests, target #3: facts.ts pure transformer.
 *
 * renderFactsForPrompt is what every Beacon AI response sees as the USER
 * PROFILE block in the system prompt. The category ORDER matters (style
 * first so the model treats it as the highest-priority dimension) and the
 * section HEADERS matter (the model uses them as hints for how strictly to
 * follow each section). Tests here lock those down so a future refactor
 * can't reorder them without explicit intent.
 *
 * The DB-touching helpers (listFactsForUser, adjustFactConfidence,
 * hasCompletedOnboarding) are intentionally left out of this first wave —
 * they need either an in-memory pg or a mock of @neondatabase/serverless,
 * which is a project of its own. Pure-transformer coverage gets us the
 * highest signal-to-noise ratio for the smallest setup cost.
 */

import { describe, it, expect } from "vitest";
import { renderFactsForPrompt, type UserFact } from "./facts";

function fact(over: Partial<UserFact>): UserFact {
  return {
    id: 1,
    email: "u@zoca.com",
    fact: "placeholder",
    category: "preference",
    source: "extracted",
    confidence: 0.85,
    created_at: "2026-05-25T00:00:00Z",
    last_seen_at: "2026-05-25T00:00:00Z",
    reference_count: 0,
    active: true,
    scope_key: null,
    ...over,
  };
}

describe("renderFactsForPrompt — empty + null cases", () => {
  it("returns null when no facts are passed", () => {
    expect(renderFactsForPrompt([])).toBeNull();
  });
});

describe("renderFactsForPrompt — category ordering", () => {
  // Phase E-12 ordering contract:
  //   1. explicit (hard constraints)
  //   2. onboarding (working-style defaults)
  //   3. style (response shape)
  //   4. tone (voice)
  //   5. depth (reasoning amount)
  //   6. preference (catch-all)
  //   7. context (who/what)
  //   8. behavior (when/how)
  it("renders explicit BEFORE all other categories", () => {
    const out = renderFactsForPrompt([
      fact({ category: "behavior", fact: "B-fact" }),
      fact({ category: "explicit", fact: "E-fact" }),
    ]);
    expect(out).not.toBeNull();
    const explicitPos = out!.indexOf("E-fact");
    const behaviorPos = out!.indexOf("B-fact");
    expect(explicitPos).toBeGreaterThanOrEqual(0);
    expect(behaviorPos).toBeGreaterThanOrEqual(0);
    expect(explicitPos).toBeLessThan(behaviorPos);
  });

  it("renders style BEFORE context", () => {
    const out = renderFactsForPrompt([
      fact({ category: "context", fact: "context-fact" }),
      fact({ category: "style", fact: "style-fact" }),
    ]);
    expect(out!.indexOf("style-fact")).toBeLessThan(out!.indexOf("context-fact"));
  });

  it("renders onboarding BEFORE style (onboarding answers are stable defaults)", () => {
    const out = renderFactsForPrompt([
      fact({ category: "style", fact: "style-fact" }),
      fact({ category: "onboarding", fact: "onboarding-fact" }),
    ]);
    expect(out!.indexOf("onboarding-fact")).toBeLessThan(out!.indexOf("style-fact"));
  });

  it("renders tone BEFORE depth, depth BEFORE preference", () => {
    const out = renderFactsForPrompt([
      fact({ category: "preference", fact: "pref-fact" }),
      fact({ category: "depth", fact: "depth-fact" }),
      fact({ category: "tone", fact: "tone-fact" }),
    ]);
    const tonePos = out!.indexOf("tone-fact");
    const depthPos = out!.indexOf("depth-fact");
    const prefPos = out!.indexOf("pref-fact");
    expect(tonePos).toBeLessThan(depthPos);
    expect(depthPos).toBeLessThan(prefPos);
  });
});

describe("renderFactsForPrompt — section headers", () => {
  it("explicit facts get a 'hard constraints' header (model reads this as authoritative)", () => {
    const out = renderFactsForPrompt([fact({ category: "explicit", fact: "X" })]);
    expect(out).toMatch(/hard constraints/i);
  });

  it("onboarding facts get a header naming the source", () => {
    const out = renderFactsForPrompt([fact({ category: "onboarding", fact: "O" })]);
    expect(out).toMatch(/onboarding/i);
  });

  it("style/tone/depth get distinct section headers", () => {
    const out = renderFactsForPrompt([
      fact({ category: "style", fact: "S" }),
      fact({ category: "tone", fact: "T" }),
      fact({ category: "depth", fact: "D" }),
    ]);
    expect(out).toMatch(/Response style:/);
    expect(out).toMatch(/Tone:/);
    expect(out).toMatch(/Reasoning depth:/);
  });
});

describe("renderFactsForPrompt — null category handling", () => {
  it("treats null category as 'explicit' (legacy /remember facts predate categorization)", () => {
    const out = renderFactsForPrompt([fact({ category: null, fact: "legacy-fact" })]);
    expect(out).toMatch(/hard constraints/i);
    expect(out).toMatch(/legacy-fact/);
  });
});

describe("renderFactsForPrompt — formatting", () => {
  it("prefixes each fact line with '- ' (markdown bullet)", () => {
    const out = renderFactsForPrompt([fact({ fact: "bullet me" })]);
    expect(out).toMatch(/^- bullet me$/m);
  });

  it("groups multiple facts of the same category under one header", () => {
    const out = renderFactsForPrompt([
      fact({ category: "style", fact: "style-A" }),
      fact({ category: "style", fact: "style-B" }),
    ]);
    // Both facts should appear under a single "Response style:" header — assert
    // there's exactly one occurrence of the header.
    const matches = (out ?? "").match(/Response style:/g) ?? [];
    expect(matches.length).toBe(1);
    expect(out).toContain("style-A");
    expect(out).toContain("style-B");
  });

  it("separates sections with a blank line", () => {
    const out = renderFactsForPrompt([
      fact({ category: "style", fact: "style-A" }),
      fact({ category: "tone", fact: "tone-A" }),
    ]);
    // Two sections → double newline between them.
    expect(out).toMatch(/style-A\n\nTone:/);
  });
});
