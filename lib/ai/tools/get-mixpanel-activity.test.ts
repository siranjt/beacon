/**
 * Tests for get_mixpanel_activity — META-A3.
 *
 * Covers:
 *   1. Happy path — Metabase aggregate returns counts; we derive
 *      engagement_tier from app_opens and surface every count.
 *   2. Empty branch — Aurora returns a single row with all NULLs (the
 *      typical shape for "no events"). We surface found=false and tier=dormant.
 *   3. Error branch — Metabase 5xx → ok=false.
 *
 * Mixpanel join key (`properties.locationEntityId`) is encoded in the SQL,
 * not the executor — so we trust the SQL string and test the executor's
 * row-shape coercion + tier math here.
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

import { getMixpanelActivityTool } from "./get-mixpanel-activity";
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

describe("get_mixpanel_activity — happy path", () => {
  it("active tier — app_opens > 20", async () => {
    runQuery.mockResolvedValueOnce([
      {
        app_opens: 45,
        distinct_session_days: 22,
        leads_marked: 18,
        leads_contacted: 9,
        review_invites_sent: 3,
        review_replies: 5,
        last_app_open_at: "2026-06-10T22:00:00Z",
        last_event_at: "2026-06-10T22:01:00Z",
      },
    ]);

    const result = await getMixpanelActivityTool.execute(
      { entity_id: ENTITY_ID, window_days: 30 },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.found).toBe(true);
    expect(data.app_opens).toBe(45);
    expect(data.distinct_session_days).toBe(22);
    expect(data.leads_marked).toBe(18);
    expect(data.leads_contacted).toBe(9);
    expect(data.review_invites_sent).toBe(3);
    expect(data.review_replies).toBe(5);
    expect(data.engagement_tier).toBe("active");
    expect(data.last_app_open_at).toBe("2026-06-10T22:00:00Z");
    expect(logUmbrellaActivity).toHaveBeenCalledTimes(1);
  });

  it("light tier — app_opens between 5 and 20 inclusive", async () => {
    runQuery.mockResolvedValueOnce([
      {
        app_opens: "8", // string-typed counts also work
        distinct_session_days: "6",
        leads_marked: "0",
        leads_contacted: 0,
        review_invites_sent: 0,
        review_replies: 0,
        last_app_open_at: "2026-06-08T22:00:00Z",
        last_event_at: "2026-06-08T22:00:00Z",
      },
    ]);

    const result = await getMixpanelActivityTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.app_opens).toBe(8);
    expect(data.engagement_tier).toBe("light");
  });

  it("cold tier — app_opens between 1 and 4", async () => {
    runQuery.mockResolvedValueOnce([
      {
        app_opens: 2,
        distinct_session_days: 1,
        leads_marked: 0,
        leads_contacted: 0,
        review_invites_sent: 0,
        review_replies: 0,
        last_app_open_at: "2026-05-30T10:00:00Z",
        last_event_at: "2026-05-30T10:00:00Z",
      },
    ]);

    const result = await getMixpanelActivityTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.engagement_tier).toBe("cold");
  });
});

describe("get_mixpanel_activity — empty branch", () => {
  it("all-null aggregate row → ok=true, found=false, dormant tier", async () => {
    runQuery.mockResolvedValueOnce([
      {
        app_opens: null,
        distinct_session_days: null,
        leads_marked: null,
        leads_contacted: null,
        review_invites_sent: null,
        review_replies: null,
        last_app_open_at: null,
        last_event_at: null,
      },
    ]);

    const result = await getMixpanelActivityTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.found).toBe(false);
    expect(data.app_opens).toBe(0);
    expect(data.engagement_tier).toBe("dormant");
    expect(data.last_app_open_at).toBeNull();
  });

  it("Metabase returns zero rows → still treated as dormant", async () => {
    runQuery.mockResolvedValueOnce([]);

    const result = await getMixpanelActivityTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.found).toBe(false);
    expect(data.engagement_tier).toBe("dormant");
  });
});

describe("get_mixpanel_activity — error branch", () => {
  it("Metabase 5xx → ok=false with helpful error", async () => {
    runQuery.mockRejectedValueOnce(new Error("Metabase /api/dataset 503: timeout"));

    const result = await getMixpanelActivityTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Mixpanel activity fetch failed");
  });

  it("missing entity_id → ok=false, no Metabase call", async () => {
    const result = await getMixpanelActivityTool.execute({}, makeCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("entity_id");
    expect(runQuery).not.toHaveBeenCalled();
  });
});
