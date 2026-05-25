/**
 * Phase E-15.3b — activity log no-DB fail-safe behavior.
 *
 * logUmbrellaActivity is fire-and-forget by design. If POSTGRES_URL isn't
 * configured (test env, local dev without DB, build-time pre-render), it
 * MUST silently return rather than throwing. Every page on the site fires
 * activity events; a throw here would cascade into 500s across the app.
 *
 * We test the contract: no-DB path returns undefined, never throws, even
 * when given pathologically bad input.
 */

import { describe, it, expect } from "vitest";
import { logUmbrellaActivity } from "./log";

describe("logUmbrellaActivity — no-DB fail-safe behavior", () => {
  it("returns undefined when no DB is wired (default test env)", async () => {
    const result = await logUmbrellaActivity({
      email: "u@zoca.com",
      event_name: "page_view",
    });
    expect(result).toBeUndefined();
  });

  it("does not throw with minimal input", async () => {
    await expect(
      logUmbrellaActivity({ email: "u@zoca.com", event_name: "test" }),
    ).resolves.toBeUndefined();
  });

  it("does not throw with full input shape", async () => {
    await expect(
      logUmbrellaActivity({
        email: "u@zoca.com",
        role: "manager",
        am_name: "Sudha",
        agent: "customer",
        event_name: "mark_contacted",
        surface: "customer_card",
        entity_id: "entity-uuid-here",
        metadata: { customer_id: "cb_abc", note_length: 42 },
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts role=null (non-customer agent users)", async () => {
    await expect(
      logUmbrellaActivity({
        email: "u@zoca.com",
        role: null,
        event_name: "page_view",
        agent: "performance",
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts agent=umbrella for cross-cutting events", async () => {
    await expect(
      logUmbrellaActivity({
        email: "u@zoca.com",
        agent: "umbrella",
        event_name: "claude_asked",
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts string event_name (extensible beyond the enum)", async () => {
    // The signature accepts `AnyEvent | string` so new event types don't
    // require adding to the type union immediately.
    await expect(
      logUmbrellaActivity({
        email: "u@zoca.com",
        event_name: "some_new_event_we_havent_typed_yet",
      }),
    ).resolves.toBeUndefined();
  });
});
