/**
 * Tests for get_full_customer_view — the cross-scope synthesis tool.
 *
 * The executor talks to ~6 different repos (snapshot, Keeper, comms
 * perspective, performance report, tickets, notes). We mock each at the
 * module boundary with vi.mock so the test stays as a unit test:
 * no Postgres, no Metabase, no Voyage/Anthropic.
 *
 * Coverage targets per the project brief:
 *   1. Happy path — all sections load, identity resolved, meta.loaded
 *      lists everything, ok=true.
 *   2. Question mode — Keeper goes through retrieveFactsHybrid and the
 *      result carries `retrieval_mode: "hybrid"` + the top-K facts.
 *   3. Soft-fail per section — when an individual sub-load throws, the
 *      tool still returns ok=true, that section is null, `meta.failed`
 *      lists it, `meta.errors_by_section` has the message.
 *   4. Customer not on book — short-circuits with found=false BEFORE
 *      any sub-load is fired (verified by zero mock calls on the side).
 *   5. Snapshot throw — returns ok=false (only path that errors to the
 *      model, since without an identity nothing else makes sense).
 *   6. AM scope — non-admin without amName gets the unavailable_reason
 *      sentinel in notes_summary instead of throwing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolExecutionContext } from "./index";

// ─── Mocks ────────────────────────────────────────────────────────────
// Each repo gets its own vi.fn so each test can re-program return values.

const readLatestSnapshotV2 = vi.fn();
const loadBrainForPrompt = vi.fn();
const retrieveFactsHybrid = vi.fn();
const readPerspective = vi.fn();
const fetchEntityReportData = vi.fn();
const fetchTicketsForCustomer = vi.fn();
const getNote = vi.fn();
const listNotesByEntity = vi.fn();
const logUmbrellaActivity = vi.fn();

vi.mock("@/lib/customer/postgres", () => ({
  readLatestSnapshotV2: () => readLatestSnapshotV2(),
}));
vi.mock("@/lib/brain/retrieval", () => ({
  loadBrainForPrompt: (...args: unknown[]) => loadBrainForPrompt(...args),
}));
vi.mock("@/lib/brain/retrieve", () => ({
  retrieveFactsHybrid: (...args: unknown[]) => retrieveFactsHybrid(...args),
}));
vi.mock("@/lib/customer/comms-perspective-store", () => ({
  readPerspective: (...args: unknown[]) => readPerspective(...args),
}));
vi.mock("@/lib/report/fetchers", () => ({
  fetchEntityReportData: (...args: unknown[]) => fetchEntityReportData(...args),
}));
vi.mock("@/lib/escalation/tickets", () => ({
  fetchTicketsForCustomer: (...args: unknown[]) =>
    fetchTicketsForCustomer(...args),
}));
vi.mock("@/lib/customer/customer-notes", () => ({
  getNote: (...args: unknown[]) => getNote(...args),
  listNotesByEntity: (...args: unknown[]) => listNotesByEntity(...args),
}));
vi.mock("@/lib/activity/log", () => ({
  logUmbrellaActivity: (...args: unknown[]) => logUmbrellaActivity(...args),
}));

// Import AFTER mocks are registered.
import { getFullCustomerViewTool } from "./get-full-customer-view";

// ─── Helpers ──────────────────────────────────────────────────────────

const ENTITY_ID = "e1b2c3d4-aaaa-bbbb-cccc-dddddddddddd";
const CB_ID = "cb_abc123";
const BIZNAME = "Pearl Salon";

function makeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    amEmail: "am@zoca.com",
    amName: "Kanak sharma",
    role: "am",
    customerId: ENTITY_ID,
    customerName: BIZNAME,
    cbCustomerId: CB_ID,
    ...overrides,
  };
}

function defaultSnapshot() {
  return {
    customers: [
      {
        entity_id: ENTITY_ID,
        company: BIZNAME,
        customer_id: CB_ID,
        am_name: "Kanak sharma",
      },
    ],
  };
}

function defaultPerf() {
  return {
    identity: {
      vertical: "salon",
      verticalDisplay: "Hair Salon",
      city: "Pune",
      state: "MH",
    },
    gbpClicks: [
      { month: "2026-03", profileClicks: 800 },
      { month: "2026-04", profileClicks: 1200 },
      { month: "2026-05", profileClicks: 1000 },
      { month: "2026-06", profileClicks: 200 }, // in-progress, partial
    ],
    keywords: [
      { keyword: "best salon", rankCurrent: 2, rankBest: 1, rankWhenJoined: 12 },
      { keyword: "balayage near me", rankCurrent: 8, rankBest: 5, rankWhenJoined: 30 },
      { keyword: "hair color", rankCurrent: 25, rankBest: 18, rankWhenJoined: null },
      { keyword: "unranked", rankCurrent: null, rankBest: null, rankWhenJoined: null },
    ],
    leads: [
      { createdAt: `${new Date().getUTCFullYear()}-01-15T00:00:00Z`, utmSource: "gbp" },
      { createdAt: `${new Date().getUTCFullYear()}-02-20T00:00:00Z`, utmSource: "gbp" },
      { createdAt: `${new Date().getUTCFullYear() - 1}-12-15T00:00:00Z`, utmSource: "gbp" },
    ],
    forecast: { reviewTarget: 4 },
  };
}

function defaultBrainPromptBlock() {
  return {
    prompt_block: {
      facts_returned: 3,
      facts_dropped: 0,
      identity: { owner_name: "Sarah Chen" },
      operational: { platform: "Vagaro" },
      behavioral: {},
      concerns: {},
      relationship: {},
      other: [],
    },
  };
}

function defaultTickets() {
  return [
    {
      identifier: "CX-100",
      title: "Billing dispute",
      state: "In Progress",
      classification: "billing",
      createdAt: "2026-05-15T00:00:00Z",
      completedAt: "",
      cancelledAt: "",
      url: "https://linear.app/x/CX-100",
    },
    {
      identifier: "CX-50",
      title: "Old fixed",
      state: "Done",
      classification: "billing",
      createdAt: "2026-05-01T00:00:00Z",
      completedAt: new Date().toISOString(),
      cancelledAt: "",
      url: "https://linear.app/x/CX-50",
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Wire happy-path defaults; individual tests can override.
  readLatestSnapshotV2.mockResolvedValue(defaultSnapshot());
  loadBrainForPrompt.mockResolvedValue(defaultBrainPromptBlock());
  retrieveFactsHybrid.mockResolvedValue({
    facts: [
      {
        fact: {
          fact_id: "f1",
          topic_category: "operational",
          topic_subcategory: "integration",
          field_name: "platform",
          value: "Vagaro",
          confirmed_at: "2026-05-01T00:00:00Z",
          source_type: "bootstrap",
        },
        matched_via: "embedding+bm25",
        rerank_score: 0.91,
        rrf_score: 0.5,
      },
    ],
    ran: ["embedding", "bm25", "rerank"],
    timing: { total_ms: 120 },
  });
  readPerspective.mockResolvedValue({
    sentiment: "warm",
    topics: ["billing"],
    substance_score: 62,
    initiator_pattern: "balanced",
    response_latency_hours: 4,
    haiku_summary: "Conversation has been steady and constructive.",
    conversation_arcs: [],
    computed_at: "2026-06-10T00:00:00Z",
  });
  fetchEntityReportData.mockResolvedValue(defaultPerf());
  fetchTicketsForCustomer.mockResolvedValue(defaultTickets());
  getNote.mockResolvedValue({
    note: "Owner Sarah prefers WhatsApp",
    updated_at: "2026-06-09T00:00:00Z",
  });
  listNotesByEntity.mockResolvedValue([]);
  logUmbrellaActivity.mockResolvedValue(undefined);
});

// ─── Tests ────────────────────────────────────────────────────────────

describe("get_full_customer_view — happy path", () => {
  it("loads every section in parallel and returns the bundled shape", async () => {
    const result = await getFullCustomerViewTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;

    // Identity resolved from the snapshot.
    expect(data.found).toBe(true);
    expect(data.identity).toMatchObject({
      entity_id: ENTITY_ID,
      bizname: BIZNAME,
      cb_customer_id: CB_ID,
      am_name: "Kanak sharma",
    });

    // No question → topic-clustered Keeper block.
    const keeper = data.keeper as Record<string, unknown>;
    expect(keeper.retrieval_mode).toBe("topic_block");
    expect(keeper.facts_returned).toBe(3);
    expect(keeper.prompt_block).toBeDefined();

    // Comms perspective came through.
    expect(data.comms_perspective).toMatchObject({
      sentiment: "warm",
      substance_score: 62,
    });

    // Performance summary — YTD leads = 2 (current year), keyword stats.
    const perf = data.performance_summary as Record<string, unknown>;
    const leads = perf.leads as { ytd: number };
    expect(leads.ytd).toBe(2);
    const keywords = perf.keywords as Record<string, number>;
    expect(keywords.active_count).toBe(3);
    expect(keywords.top3_count).toBe(1);
    expect(keywords.top10_count).toBe(2);
    // GBP peak should be from COMPLETE months only — 1200 in 2026-04,
    // not the partial 2026-06.
    const gbp = perf.gbp_clicks as Record<string, { month: string; clicks: number } | null>;
    expect(gbp.peak_complete_month?.month).toBe("2026-04");
    expect(gbp.current_month?.month).toBe("2026-06");

    // Escalations: 1 open, 1 closed-30d.
    const esc = data.escalations as Record<string, unknown>;
    expect(esc.open_count).toBe(1);
    expect(esc.closed_last_30d_count).toBe(1);

    // Notes summary — AM scope, own note returned.
    const notes = data.notes_summary as Record<string, unknown>;
    expect(notes.scope).toBe("own-am");
    expect(notes.am_name).toBe("Kanak sharma");

    // Meta block shape.
    const meta = data.meta as Record<string, unknown>;
    expect(meta.loaded).toEqual(
      expect.arrayContaining([
        "keeper",
        "comms_perspective",
        "performance_summary",
        "escalations",
        "notes_summary",
      ]),
    );
    expect(meta.failed).toEqual([]);
    expect(meta.errors_by_section).toBeNull();
    expect(typeof meta.total_ms).toBe("number");

    // Hybrid retriever should NOT have been called (no question).
    expect(retrieveFactsHybrid).not.toHaveBeenCalled();

    // Activity log was emitted.
    expect(logUmbrellaActivity).toHaveBeenCalledTimes(1);
  });
});

describe("get_full_customer_view — question mode", () => {
  it("routes Keeper through retrieveFactsHybrid and surfaces topK facts", async () => {
    const result = await getFullCustomerViewTool.execute(
      { entity_id: ENTITY_ID, question: "churn risk picture" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    const keeper = data.keeper as Record<string, unknown>;
    expect(keeper.retrieval_mode).toBe("hybrid");
    expect(keeper.question).toBe("churn risk picture");
    expect(keeper.facts_returned).toBe(1);
    const facts = keeper.facts as Array<Record<string, unknown>>;
    expect(facts[0]).toMatchObject({
      field_name: "platform",
      value: "Vagaro",
      relevance_score: 0.91,
    });

    // Hybrid path called once with the right topK + customer_id.
    expect(retrieveFactsHybrid).toHaveBeenCalledTimes(1);
    expect(retrieveFactsHybrid).toHaveBeenCalledWith(
      "churn risk picture",
      expect.objectContaining({ customer_id: CB_ID, topK: 10 }),
    );
    // Dump-all path NOT called when question is provided.
    expect(loadBrainForPrompt).not.toHaveBeenCalled();
  });
});

describe("get_full_customer_view — soft-fail per section", () => {
  it("each rejecting sub-loader yields null + a meta.failed entry, tool still ok", async () => {
    // Make performance + escalations + perspective all throw.
    fetchEntityReportData.mockRejectedValueOnce(new Error("Metabase down"));
    fetchTicketsForCustomer.mockRejectedValueOnce(new Error("Linear timeout"));
    readPerspective.mockRejectedValueOnce(new Error("comms store offline"));

    const result = await getFullCustomerViewTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.performance_summary).toBeNull();
    expect(data.escalations).toBeNull();
    expect(data.comms_perspective).toBeNull();
    // Keeper + notes still loaded.
    expect(data.keeper).not.toBeNull();
    expect(data.notes_summary).not.toBeNull();

    const meta = data.meta as Record<string, unknown>;
    const failed = meta.failed as string[];
    expect(failed).toEqual(
      expect.arrayContaining([
        "performance_summary",
        "escalations",
        "comms_perspective",
      ]),
    );
    expect(failed).not.toContain("keeper");
    expect(failed).not.toContain("notes_summary");

    const errors = meta.errors_by_section as Record<string, string>;
    expect(errors.performance_summary).toContain("Metabase down");
    expect(errors.escalations).toContain("Linear timeout");
    expect(errors.comms_perspective).toContain("comms store offline");

    // Summary string should mention what's missing.
    expect(result.summary).toContain("missing");
  });

  it("Keeper failure is isolated — other sections unaffected", async () => {
    loadBrainForPrompt.mockRejectedValueOnce(new Error("brain unavailable"));

    const result = await getFullCustomerViewTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.keeper).toBeNull();
    expect(data.performance_summary).not.toBeNull();
    expect(data.comms_perspective).not.toBeNull();
    const meta = data.meta as Record<string, unknown>;
    expect((meta.failed as string[])).toContain("keeper");
  });
});

describe("get_full_customer_view — customer not on book", () => {
  it("short-circuits with found=false and does NOT fire sub-loaders", async () => {
    readLatestSnapshotV2.mockResolvedValueOnce({ customers: [] });

    const result = await getFullCustomerViewTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.found).toBe(false);
    expect(data.keeper).toBeNull();
    expect(data.performance_summary).toBeNull();

    // Critical: NONE of the sub-loaders should have been invoked.
    expect(loadBrainForPrompt).not.toHaveBeenCalled();
    expect(retrieveFactsHybrid).not.toHaveBeenCalled();
    expect(readPerspective).not.toHaveBeenCalled();
    expect(fetchEntityReportData).not.toHaveBeenCalled();
    expect(fetchTicketsForCustomer).not.toHaveBeenCalled();
    expect(getNote).not.toHaveBeenCalled();
    expect(listNotesByEntity).not.toHaveBeenCalled();
  });
});

describe("get_full_customer_view — snapshot failure", () => {
  it("returns ok=false when the identity lookup itself throws", async () => {
    readLatestSnapshotV2.mockRejectedValueOnce(new Error("DB unreachable"));

    const result = await getFullCustomerViewTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("snapshot lookup failed");
  });
});

describe("get_full_customer_view — manager scope notes", () => {
  it("manager role gets all-AMs notes shape regardless of amName", async () => {
    listNotesByEntity.mockResolvedValueOnce([
      {
        am_name: "Kanak sharma",
        bizname: BIZNAME,
        note: "K's note about Pearl",
        updated_at: "2026-06-01T00:00:00Z",
      },
      {
        am_name: "Hubern C",
        bizname: BIZNAME,
        note: "H's note about Pearl",
        updated_at: "2026-05-30T00:00:00Z",
      },
    ]);

    const result = await getFullCustomerViewTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx({ role: "manager", amName: null }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    const notes = data.notes_summary as Record<string, unknown>;
    expect(notes.scope).toBe("all-ams");
    expect(notes.note_count).toBe(2);
    // getNote (AM path) should NOT have been called.
    expect(getNote).not.toHaveBeenCalled();
  });

  it("AM without an amName mapping returns the unavailable_reason sentinel (no throw)", async () => {
    const result = await getFullCustomerViewTool.execute(
      { entity_id: ENTITY_ID },
      makeCtx({ role: "am", amName: null }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    const notes = data.notes_summary as Record<string, unknown>;
    expect(notes.scope).toBe("own-am");
    expect(notes.note).toBeNull();
    expect(notes.unavailable_reason).toContain("not mapped");
    // Notes section IS loaded (just sparse) — should NOT appear in failed.
    const meta = data.meta as Record<string, unknown>;
    expect((meta.failed as string[])).not.toContain("notes_summary");
  });
});

describe("get_full_customer_view — input validation", () => {
  it("returns ok=false when entity_id is missing", async () => {
    const result = await getFullCustomerViewTool.execute({}, makeCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("entity_id");
  });

  it("returns ok=false when entity_id is empty string", async () => {
    const result = await getFullCustomerViewTool.execute(
      { entity_id: "   " },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
  });
});
