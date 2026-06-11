/**
 * Tests for get_booking_history — META-A3.
 *
 * Covers the three branches the executor exposes:
 *   1. Happy path — Metabase returns rows; we count, derive conversion
 *      rate + top utm_source + recent 5.
 *   2. Empty branch — Metabase returns []; we return ok=true with
 *      found=false (soft-fail to model).
 *   3. Error branch — Metabase 5xx; we return ok=false with a clean
 *      error message.
 *
 * The cache module is module-scoped and reset between tests via
 * `_resetForTests()` so we never see stale state from the previous case.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolExecutionContext } from "./index";

const runQuery = vi.fn();
const logUmbrellaActivity = vi.fn();

vi.mock("@/lib/metabase", () => ({
  runQuery: (opts: unknown) => runQuery(opts),
  DB: { AURORA: 7, POSTGRES: 2, STAGING: 3 },
}));
vi.mock("@/lib/activity/log", () => ({
  logUmbrellaActivity: (...args: unknown[]) => logUmbrellaActivity(...args),
}));

import { getBookingHistoryTool } from "./get-booking-history";
import { _resetForTests } from "@/lib/ai/context-cache";

const ENTITY_ID = "e1b2c3d4-aaaa-bbbb-cccc-dddddddddddd";

function makeCtx(): ToolExecutionContext {
  return {
    amEmail: "am@zoca.com",
    amName: "Kanak sharma",
    role: "am",
    customerId: ENTITY_ID,
    customerName: "Pearl Salon",
    cbCustomerId: "cb_abc",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  logUmbrellaActivity.mockResolvedValue(undefined);
});

describe("get_booking_history — happy path", () => {
  it("returns leads_total, converted, conversion_rate, top utm_source, recent 5", async () => {
    runQuery.mockResolvedValueOnce([
      {
        id: "1",
        created_at: "2026-06-10T10:00:00Z",
        status: "open",
        utm_source: "gbp",
        booking_id: "b1",
        first_name: "Aisha",
        service: "cut",
      },
      {
        id: "2",
        created_at: "2026-06-09T10:00:00Z",
        status: "open",
        utm_source: "gbp",
        booking_id: null,
        first_name: "Brian",
        service: "color",
      },
      {
        id: "3",
        created_at: "2026-06-08T10:00:00Z",
        status: "open",
        utm_source: "direct",
        booking_id: "b3",
        first_name: "Cara",
        service: "balayage",
      },
      {
        id: "4",
        created_at: "2026-06-07T10:00:00Z",
        status: "open",
        utm_source: null,
        booking_id: null,
        first_name: null,
        service: null,
      },
    ]);

    const result = await getBookingHistoryTool.execute(
      { entity_id: ENTITY_ID, window_days: 30 },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.found).toBe(true);
    expect(data.leads_total).toBe(4);
    expect(data.leads_converted_to_booking).toBe(2);
    expect(data.conversion_rate).toBe(50);
    expect(data.top_utm_source).toBe("gbp");
    const recent = data.recent_5_leads as Array<{ id: string; converted: boolean }>;
    expect(recent.length).toBe(4);
    expect(recent[0].id).toBe("1");
    expect(recent[0].converted).toBe(true);
    expect(logUmbrellaActivity).toHaveBeenCalledTimes(1);
  });
});

describe("get_booking_history — empty branch", () => {
  it("Metabase returns no rows → ok=true with found=false", async () => {
    runQuery.mockResolvedValueOnce([]);

    const result = await getBookingHistoryTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.found).toBe(false);
    expect(data.leads_total).toBe(0);
    expect(data.leads_converted_to_booking).toBe(0);
    expect(data.conversion_rate).toBe(0);
    expect(data.top_utm_source).toBeNull();
    expect((data.recent_5_leads as unknown[]).length).toBe(0);
    // Default window applied.
    expect(data.window_days).toBe(90);
  });
});

describe("get_booking_history — error branch", () => {
  it("Metabase 5xx → ok=false with helpful error", async () => {
    runQuery.mockRejectedValueOnce(new Error("Metabase /api/dataset 500: outage"));

    const result = await getBookingHistoryTool.execute(
      { entity_id: ENTITY_ID, window_days: 30 },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Booking history fetch failed");
    expect(result.error).toContain("Metabase");
  });

  it("missing entity_id → ok=false with validation message", async () => {
    const result = await getBookingHistoryTool.execute({}, makeCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("entity_id");
    expect(runQuery).not.toHaveBeenCalled();
  });
});
