import { createHash } from "crypto";
import { getSql, readRecentActions, readSnapshotByDate } from "./postgres";
import { getCoachingPerAm } from "./coaching";
import type { CoachingRow } from "./coaching";
import { callHaikuJson, llmConfigured } from "./llm";
import { POD_MAP, TICKETS_STALE_DAYS } from "./config";
import type { SnapshotV2, ScoredCustomerV2, AmActionRow } from "./types";

/**
 * Phase 29 — Manager 1:1 prep mode.
 *
 * Self-heals `one_on_one_log` on first read/write. Generates rule-based
 * talking points deterministically; optionally enriches them via Haiku for
 * warmer phrasing. Compares the snapshot at the last 1:1 (or 7 days ago)
 * against today's snapshot to surface "wins since last 1:1".
 *
 * Module-level `_ready` flag prevents repeat CREATE TABLE per process.
 */

export type OneOnOneActionItem = {
  text: string;
  done: boolean;
  assignee?: string;
};

export type OneOnOneLogRow = {
  id: number;
  am_name: string;
  manager_email: string | null;
  held_at: string;
  notes: string | null;
  action_items: OneOnOneActionItem[];
  talking_points_used: string[] | null;
  metrics_snapshot: Record<string, unknown> | null;
  created_at: string;
};

export type TalkingPointKind = "celebrate" | "constructive" | "warning" | "ask";

export type TalkingPoint = {
  id: string;
  kind: TalkingPointKind;
  headline: string;
  detail: string;
  supporting_metric?: { label: string; value: string };
};

export type OneOnOneBookSummary = {
  total: number;
  red: number;
  yellow: number;
  green: number;
  mrr_total_cents: number;
  mrr_at_risk_cents: number;
};

export type OneOnOneActionsRecap = {
  total: number;
  connected: number;
  voicemail: number;
  no_reach: number;
  escalated: number;
  action_rate_pct: number;
};

export type OneOnOneWin = {
  entity_id: string;
  bizname: string;
  previous_stoplight: "RED" | "YELLOW";
  current_stoplight: "YELLOW" | "GREEN";
};

/** Phase 31.v2 — per-customer stale-tickets row used by the manager 1:1 talking
 *  points. Stays optional on OneOnOnePrepData so existing call sites that
 *  build the prep manually (tests, mocks) don't need to set this field. */
export type OneOnOneStaleTicketsRow = {
  bizname: string;
  open_count: number;
  stale_count: number;
  oldest_age_days: number;
};

export type OneOnOneBookSummaryExtended = {
  customers_with_stale_tickets: OneOnOneStaleTicketsRow[];
};

export type OneOnOnePrepData = {
  am_name: string;
  pod: string | null;
  generated_at: string;
  last_one_on_one: OneOnOneLogRow | null;
  book_summary: OneOnOneBookSummary;
  /** Phase 31.v2 — auxiliary book-level stats that don't fit the headline
   *  OneOnOneBookSummary triplet. Optional for backwards compat. */
  book_summary_extended?: OneOnOneBookSummaryExtended;
  actions_last_7d: OneOnOneActionsRecap;
  wins_since_last_one_on_one: OneOnOneWin[];
  coaching: CoachingRow | null;
  talking_points_rule_based: TalkingPoint[];
};

// ---------------------------------------------------------------------------
// Schema self-heal
// ---------------------------------------------------------------------------

let _ready = false;

export async function ensureOneOnOneSchema(): Promise<boolean> {
  if (_ready) return true;
  const sql = getSql();
  if (!sql) return false;
  await sql`
    CREATE TABLE IF NOT EXISTS one_on_one_log (
      id SERIAL PRIMARY KEY,
      am_name TEXT NOT NULL,
      manager_email TEXT,
      held_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notes TEXT,
      action_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      talking_points_used JSONB,
      metrics_snapshot JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_one_on_one_log_am ON one_on_one_log (am_name, held_at DESC)`;
  _ready = true;
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return new Date().toISOString();
}

function parseActionItems(v: unknown): OneOnOneActionItem[] {
  if (!Array.isArray(v)) return [];
  const out: OneOnOneActionItem[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.text !== "string") continue;
    out.push({
      text: o.text,
      done: !!o.done,
      assignee: typeof o.assignee === "string" ? o.assignee : undefined,
    });
  }
  return out;
}

function parseStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string");
}

function parseMetricsSnapshot(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function rowToOneOnOne(row: Record<string, unknown>): OneOnOneLogRow {
  return {
    id: Number(row.id ?? 0),
    am_name: String(row.am_name ?? ""),
    manager_email: typeof row.manager_email === "string" ? row.manager_email : null,
    held_at: toIso(row.held_at),
    notes: typeof row.notes === "string" ? row.notes : null,
    action_items: parseActionItems(row.action_items),
    talking_points_used: parseStringArray(row.talking_points_used),
    metrics_snapshot: parseMetricsSnapshot(row.metrics_snapshot),
    created_at: toIso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export async function readLastOneOnOne(amName: string): Promise<OneOnOneLogRow | null> {
  const ready = await ensureOneOnOneSchema();
  if (!ready) return null;
  const sql = getSql();
  if (!sql) return null;
  const rows = await sql`
    SELECT id, am_name, manager_email, held_at, notes, action_items,
           talking_points_used, metrics_snapshot, created_at
    FROM one_on_one_log
    WHERE am_name = ${amName}
    ORDER BY held_at DESC
    LIMIT 1
  `;
  if (!rows.length) return null;
  return rowToOneOnOne(rows[0] as Record<string, unknown>);
}

export async function readOneOnOneHistory(
  amName: string,
  limit: number = 10,
): Promise<OneOnOneLogRow[]> {
  const ready = await ensureOneOnOneSchema();
  if (!ready) return [];
  const sql = getSql();
  if (!sql) return [];
  const safeLimit = Math.max(1, Math.min(100, limit | 0));
  const rows = await sql`
    SELECT id, am_name, manager_email, held_at, notes, action_items,
           talking_points_used, metrics_snapshot, created_at
    FROM one_on_one_log
    WHERE am_name = ${amName}
    ORDER BY held_at DESC
    LIMIT ${safeLimit}
  `;
  return rows.map((r) => rowToOneOnOne(r as Record<string, unknown>));
}

export async function writeOneOnOne(
  row: Omit<OneOnOneLogRow, "id" | "created_at">,
): Promise<number> {
  const ready = await ensureOneOnOneSchema();
  if (!ready) {
    throw new Error("[one-on-one] POSTGRES_URL not configured — cannot persist 1:1 log");
  }
  const sql = getSql();
  if (!sql) {
    throw new Error("[one-on-one] POSTGRES_URL not configured — cannot persist 1:1 log");
  }
  const result = await sql`
    INSERT INTO one_on_one_log (
      am_name, manager_email, held_at, notes, action_items,
      talking_points_used, metrics_snapshot
    ) VALUES (
      ${row.am_name},
      ${row.manager_email ?? null},
      ${row.held_at},
      ${row.notes ?? null},
      ${JSON.stringify(row.action_items ?? [])}::jsonb,
      ${row.talking_points_used ? JSON.stringify(row.talking_points_used) : null}::jsonb,
      ${row.metrics_snapshot ? JSON.stringify(row.metrics_snapshot) : null}::jsonb
    )
    RETURNING id
  `;
  return Number((result[0] as { id?: number })?.id ?? 0);
}

// ---------------------------------------------------------------------------
// Per-AM summary listing (used by the picker page)
// ---------------------------------------------------------------------------

export type OneOnOneAmSummary = {
  am_name: string;
  pod: string | null;
  last_one_on_one_date: string | null;
  red_count: number;
  mrr_at_risk_cents: number;
};

export async function readLastOneOnOneDatesByAm(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ready = await ensureOneOnOneSchema();
  if (!ready) return out;
  const sql = getSql();
  if (!sql) return out;
  const rows = await sql`
    SELECT am_name, MAX(held_at) AS last_held
    FROM one_on_one_log
    GROUP BY am_name
  `;
  for (const r of rows) {
    const row = r as { am_name?: string; last_held?: unknown };
    if (!row.am_name) continue;
    out.set(row.am_name, toIso(row.last_held));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build full prep data
// ---------------------------------------------------------------------------

function bookSummaryFor(customers: ScoredCustomerV2[]): OneOnOneBookSummary {
  let red = 0;
  let yellow = 0;
  let green = 0;
  let mrrTotal = 0;
  let mrrAtRisk = 0;
  for (const c of customers) {
    // Phase 33.scope-fix6 — recently_churned customers stay visible in scope
    // for 30 days but should NOT pollute book-level RED/YELLOW/GREEN/MRR
    // tallies. Their MRR is already gone; their tier is forced HEALTHY.
    if ((c as any).lifecycle_state === "recently_churned") continue;
    const planCents = Math.round((c.plan_amount || 0) * 100);
    mrrTotal += planCents;
    // Phase 33.H.7 — read metabase_health.tier (MONITOR fallback for missing data)
      const _htRaw = ((c as any).metabase_health?.health_tier as string | null | undefined) || "";
      const _ht =
        _htRaw === "CRITICAL - DEAL BREAKER" || _htRaw === "CRITICAL" ? "CRITICAL"
        : _htRaw === "AT-RISK" ? "AT-RISK"
        : _htRaw === "HEALTHY" ? "HEALTHY"
        : "MONITOR";
    if (_ht === "CRITICAL" || _ht === "AT-RISK") {
      red += 1;
      mrrAtRisk += planCents;
    } else if (_ht === "MONITOR") {
      yellow += 1;
    } else if (_ht === "HEALTHY") {
      green += 1;
    }
  }
  return {
    total: customers.length,
    red,
    yellow,
    green,
    mrr_total_cents: mrrTotal,
    mrr_at_risk_cents: mrrAtRisk,
  };
}

function actionsRecapFor(
  actions: AmActionRow[],
  redCount: number,
): OneOnOneActionsRecap {
  let connected = 0;
  let voicemail = 0;
  let noReach = 0;
  let escalated = 0;
  for (const a of actions) {
    switch (a.action_type) {
      case "contacted_connected":
        connected += 1;
        break;
      case "contacted_vm":
        voicemail += 1;
        break;
      case "contacted_noreach":
        noReach += 1;
        break;
      case "escalated":
        escalated += 1;
        break;
    }
  }
  const total = actions.length;
  const action_rate_pct = redCount > 0 ? Math.round((total / redCount) * 100) : 0;
  return { total, connected, voicemail, no_reach: noReach, escalated, action_rate_pct };
}

function ymd(iso: string): string {
  return iso.slice(0, 10);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function computeWinsSinceLast1on1(
  currentCustomers: ScoredCustomerV2[],
  comparisonIso: string,
): Promise<OneOnOneWin[]> {
  const date = ymd(comparisonIso);
  const prevSnap = await readSnapshotByDate(date);
  if (!prevSnap) return [];

  const prevByEntity = new Map<string, ScoredCustomerV2>();
  for (const c of prevSnap.customers || []) {
    if (c?.entity_id) prevByEntity.set(c.entity_id, c);
  }

  const wins: OneOnOneWin[] = [];
  for (const cur of currentCustomers) {
    const prev = prevByEntity.get(cur.entity_id);
    if (!prev) continue;
    const prevSl = prev.signals_v2?.stoplight;
    const curSl = cur.signals_v2?.stoplight;
    if (!prevSl || !curSl) continue;
    // RED → YELLOW or GREEN  |  YELLOW → GREEN
    if (prevSl === "RED" && (curSl === "YELLOW" || curSl === "GREEN")) {
      wins.push({
        entity_id: cur.entity_id,
        bizname: cur.company || "",
        previous_stoplight: "RED",
        current_stoplight: curSl,
      });
    } else if (prevSl === "YELLOW" && curSl === "GREEN") {
      wins.push({
        entity_id: cur.entity_id,
        bizname: cur.company || "",
        previous_stoplight: "YELLOW",
        current_stoplight: "GREEN",
      });
    }
  }
  return wins;
}

async function recentActionsForAm(amName: string, daysBack: number): Promise<AmActionRow[]> {
  const all = await readRecentActions(daysBack);
  return all.filter((a) => a.am_name === amName);
}

export async function buildOneOnOnePrep(
  snapshot: SnapshotV2,
  amName: string,
): Promise<OneOnOnePrepData> {
  const generated_at = new Date().toISOString();
  const customers = (snapshot.customers || []).filter((c) => c.am_name === amName);
  const book_summary = bookSummaryFor(customers);

  const last = await readLastOneOnOne(amName);

  // Action rate denominator is the current RED count, not all actions.
  const actions = await recentActionsForAm(amName, 7);
  const actions_last_7d = actionsRecapFor(actions, book_summary.red);

  // Wins comparison: from the last 1:1 date, else 7 days ago.
  const comparisonIso = last?.held_at ?? daysAgoIso(7);
  const wins_since_last_one_on_one = await computeWinsSinceLast1on1(
    customers,
    comparisonIso,
  );

  // Coaching row for this AM
  let coachingRow: CoachingRow | null = null;
  try {
    const allCoaching = await getCoachingPerAm(snapshot);
    coachingRow = allCoaching.find((r) => r.am_name === amName) ?? null;
  } catch {
    coachingRow = null;
  }

  // -------------------------------------------------------------------------
  // Phase 31.v2 — derive the per-AM stale-tickets list from the snapshot's
  // attached Metabase records. Empty list when no customers have stale open
  // tickets (which is the common case for healthy books).
  // -------------------------------------------------------------------------
  const customersWithStaleTickets = customers
    .filter((c) => (c.tickets?.open_stale_count ?? 0) > 0)
    .map((c) => ({
      bizname: c.company || c.entity_id.slice(0, 8),
      open_count: c.tickets!.open_count ?? 0,
      stale_count: c.tickets!.open_stale_count ?? 0,
      oldest_age_days: c.tickets!.oldest_open_age_days ?? 0,
    }))
    .sort((a, b) => b.stale_count - a.stale_count);

  const book_summary_extended: OneOnOneBookSummaryExtended = {
    customers_with_stale_tickets: customersWithStaleTickets,
  };

  const partial: Omit<OneOnOnePrepData, "talking_points_rule_based"> = {
    am_name: amName,
    pod: POD_MAP[amName] ?? null,
    generated_at,
    last_one_on_one: last,
    book_summary,
    book_summary_extended,
    actions_last_7d,
    wins_since_last_one_on_one,
    coaching: coachingRow,
  };

  const talking_points_rule_based = generateRuleBasedTalkingPoints(partial, customers);

  return { ...partial, talking_points_rule_based };
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

function stableId(kind: string, headline: string): string {
  return createHash("md5").update(`${kind}|${headline}`).digest("hex").slice(0, 8);
}

function fmtMoney(cents: number): string {
  const dollars = Math.round(cents / 100);
  return `$${dollars.toLocaleString()}`;
}

function makePoint(
  kind: TalkingPointKind,
  headline: string,
  detail: string,
  supporting_metric?: { label: string; value: string },
): TalkingPoint {
  return { id: stableId(kind, headline), kind, headline, detail, supporting_metric };
}

export function generateRuleBasedTalkingPoints(
  prep: Omit<OneOnOnePrepData, "talking_points_rule_based">,
  customers?: ScoredCustomerV2[],
): TalkingPoint[] {
  const celebrate: TalkingPoint[] = [];
  const constructive: TalkingPoint[] = [];
  const warning: TalkingPoint[] = [];
  const ask: TalkingPoint[] = [];

  const winsCount = prep.wins_since_last_one_on_one.length;
  const book = prep.book_summary;
  const actions = prep.actions_last_7d;
  const coaching = prep.coaching;

  // -- CELEBRATE --------------------------------------------------------------
  if (winsCount > 0) {
    const plural = winsCount === 1 ? "" : "s";
    const sample = prep.wins_since_last_one_on_one
      .slice(0, 3)
      .map((w) => w.bizname || w.entity_id.slice(0, 8))
      .join(", ");
    celebrate.push(
      makePoint(
        "celebrate",
        `${winsCount} customer${plural} recovered since your last 1:1`,
        `Customers that moved out of RED/YELLOW: ${sample}${
          winsCount > 3 ? `, +${winsCount - 3} more` : ""
        }. Worth naming the specific moves they made.`,
        { label: "Recovered", value: String(winsCount) },
      ),
    );
  }

  if (actions.action_rate_pct >= 70) {
    celebrate.push(
      makePoint(
        "celebrate",
        `Action rate this week: ${actions.action_rate_pct}% — keep this cadence`,
        `${actions.total} actions logged against ${book.red} needs-call customers. Top of the team on coverage.`,
        { label: "Action rate", value: `${actions.action_rate_pct}%` },
      ),
    );
  }

  // -- CONSTRUCTIVE -----------------------------------------------------------
  if (coaching && coaching.red_untouched_7d.count > 5) {
    const c = coaching.red_untouched_7d.count;
    constructive.push(
      makePoint(
        "constructive",
        `${c} needs-call customers untouched for 7+ days`,
        `These are accounts where no comms and no am_action have been logged in the last 7 days. Trend vs last 1:1 unknown until we wire snapshot-diffing — for now, prioritize triage on the top-MRR ones.`,
        { label: "Untouched 7d", value: String(c) },
      ),
    );
  }

  if (coaching && coaching.stale_red_14d.count > 3) {
    const c = coaching.stale_red_14d.count;
    constructive.push(
      makePoint(
        "constructive",
        `${c} customers in Critical/At-risk for 14+ days — escalate or change approach`,
        `Stale RED is the strongest churn predictor in our cohort. If touch hasn't worked, try escalating to AE/pod lead or switching channel.`,
        { label: "Stale 14d", value: String(c) },
      ),
    );
  }

  if (coaching && coaching.noreach_streak_3plus.count >= 1) {
    const c = coaching.noreach_streak_3plus.count;
    const pluralC = c === 1 ? "" : "s";
    constructive.push(
      makePoint(
        "constructive",
        `${c} customer${pluralC} in a 3+ no-reach streak`,
        `Three consecutive "No reach" outcomes usually means stale contact info. Worth handing to ops for a phone/email cleanup pass.`,
        { label: "No-reach streak", value: String(c) },
      ),
    );
  }

  if (coaching && coaching.snooze_ignored.count > 0) {
    const c = coaching.snooze_ignored.count;
    constructive.push(
      makePoint(
        "constructive",
        `${c} snooze${c === 1 ? "" : "s"} elapsed without follow-up`,
        `Snoozed customers came back into scope but haven't been re-touched. Suggest building a weekly snooze sweep into the cadence.`,
        { label: "Snooze ignored", value: String(c) },
      ),
    );
  }

  if (book.red > 0 && actions.action_rate_pct < 30) {
    constructive.push(
      makePoint(
        "constructive",
        `Action rate is ${actions.action_rate_pct}% — below 50% baseline`,
        `${actions.total} actions logged against ${book.red} needs-call customers in the last 7 days. Open question: what's blocking? Capacity, prioritization, or system access?`,
        { label: "Action rate", value: `${actions.action_rate_pct}%` },
      ),
    );
  }

  if (book.total > 0 && book.red / book.total > 0.35) {
    const pct = Math.round((book.red / book.total) * 100);
    constructive.push(
      makePoint(
        "constructive",
        `${pct}% of book needs a call — may need rebalancing`,
        `${book.red} of ${book.total} accounts in Critical/At-risk. If the load is structural rather than situational, consider redistributing accounts or pairing with a co-AM.`,
        { label: "% Needs call", value: `${pct}%` },
      ),
    );
  }

  // Phase 31.v2 — stale support tickets across the AM's book.
  // Rule of thumb: ≥1 customer with open tickets older than TICKETS_STALE_DAYS
  // is worth surfacing. We name the worst 3 (by stale count) and roll the
  // total stale count into the supporting metric.
  const stale = prep.book_summary_extended?.customers_with_stale_tickets ?? [];
  if (stale.length > 0) {
    const top3 = stale
      .slice(0, 3)
      .map((c) => `${c.bizname} (${c.stale_count} stale, oldest ${c.oldest_age_days}d)`)
      .join(", ");
    const more = stale.length > 3 ? ` and ${stale.length - 3} more` : "";
    const totalStale = stale.reduce((s, c) => s + c.stale_count, 0);
    constructive.push(
      makePoint(
        "constructive",
        `${stale.length} customer${stale.length === 1 ? " has" : "s have"} tickets older than ${TICKETS_STALE_DAYS} days`,
        `${top3}${more}. Worth a status check with the AM on whether the customers are being kept in the loop.`,
        { label: "stale total", value: String(totalStale) },
      ),
    );
  }

  // -- WARNING ----------------------------------------------------------------
  if (book.mrr_at_risk_cents > 500_000) {
    let topAccounts = "";
    if (customers && customers.length) {
      const topRed = customers
        .filter((c) => { const _ht = String(((c as any).metabase_health?.health_tier) || ""); return _ht === "CRITICAL - DEAL BREAKER" || _ht === "CRITICAL" || _ht === "AT-RISK"; })
        .sort((a, b) => (b.plan_amount || 0) - (a.plan_amount || 0))
        .slice(0, 2)
        .map((c) => c.company || c.entity_id.slice(0, 8));
      if (topRed.length) topAccounts = ` Top accounts: ${topRed.join(", ")}.`;
    }
    warning.push(
      makePoint(
        "warning",
        `${fmtMoney(book.mrr_at_risk_cents)} MRR sitting in the Needs-call tier`,
        `Material churn exposure on this book.${topAccounts} Prioritize a save plan or escalate to AE.`,
        { label: "MRR at risk", value: `${fmtMoney(book.mrr_at_risk_cents)}/mo` },
      ),
    );
  }

  if (actions.total === 0 && book.red > 0) {
    warning.push(
      makePoint(
        "warning",
        "No actions logged in the last 7 days",
        "Confirm the AM is engaged + has dashboard access. If they're working in another tool, fold their work back into am_actions so coverage is visible.",
        { label: "Actions 7d", value: "0" },
      ),
    );
  }

  // -- ASK --------------------------------------------------------------------
  if (customers && customers.length) {
    const topRedNames = customers
      .filter((c) => { const _ht = String(((c as any).metabase_health?.health_tier) || ""); return _ht === "CRITICAL - DEAL BREAKER" || _ht === "CRITICAL" || _ht === "AT-RISK"; })
      .sort((a, b) => (b.plan_amount || 0) - (a.plan_amount || 0))
      .slice(0, 3)
      .map((c) => c.company || c.entity_id.slice(0, 8));
    if (topRedNames.length) {
      ask.push(
        makePoint(
          "ask",
          `Anything blocking on the top Needs-call accounts?`,
          `Open-ended check on: ${topRedNames.join(", ")}. Ask what's needed from you (escalation, exec sponsor, pricing room).`,
          { label: "Top Needs-call", value: String(topRedNames.length) },
        ),
      );
    }
  }

  // Compose with priority: celebrate → constructive → warning → ask, cap at 7.
  return [...celebrate, ...constructive, ...warning, ...ask].slice(0, 7);
}

// ---------------------------------------------------------------------------
// LLM enrichment
// ---------------------------------------------------------------------------

type EnrichResponse = {
  points?: Array<{
    id?: string;
    kind?: string;
    headline?: string;
    detail?: string;
    supporting_metric?: { label?: string; value?: string };
  }>;
};

const VALID_KINDS = new Set<TalkingPointKind>([
  "celebrate",
  "constructive",
  "warning",
  "ask",
]);

export async function enrichTalkingPoints(
  rules: TalkingPoint[],
  context: OneOnOnePrepData,
): Promise<TalkingPoint[]> {
  if (!llmConfigured()) return rules;
  if (!rules.length) return rules;

  const contextLite = {
    am_name: context.am_name,
    pod: context.pod,
    book_summary: context.book_summary,
    actions_last_7d: context.actions_last_7d,
    wins: context.wins_since_last_one_on_one.length,
    coaching: context.coaching
      ? {
          untouched_7d: context.coaching.red_untouched_7d.count,
          stale_14d: context.coaching.stale_red_14d.count,
          noreach_streak: context.coaching.noreach_streak_3plus.count,
          snooze_ignored: context.coaching.snooze_ignored.count,
        }
      : null,
  };

  const system =
    "You are helping a manager prepare for a 1:1 with their Account Manager. " +
    "You rewrite rule-generated talking points with warmer, more constructive " +
    "phrasing while preserving accuracy. Never invent numbers. Headlines must " +
    "stay under 80 characters. Return JSON only.";

  const prompt = [
    "Below are rule-generated talking points and supporting data. Rewrite",
    "each talking point with warmer, more constructive phrasing while",
    "preserving accuracy. Keep headlines under 80 chars. Preserve every id.",
    "Return JSON in this exact shape:",
    "{",
    '  "points": [',
    '    { "id": "<original id>", "kind": "celebrate|constructive|warning|ask",',
    '      "headline": "...", "detail": "...",',
    '      "supporting_metric": { "label": "...", "value": "..." } }',
    "  ]",
    "}",
    "",
    "CONTEXT:",
    JSON.stringify(contextLite, null, 2),
    "",
    "POINTS:",
    JSON.stringify(rules, null, 2),
  ].join("\n");

  const fallback: EnrichResponse = { points: [] };
  const result = await callHaikuJson<EnrichResponse>(
    {
      system,
      prompt,
      maxTokens: 1200,
      temperature: 0.4,
      timeoutMs: 12_000,
    },
    fallback,
  );

  if (!result?.points || !Array.isArray(result.points) || !result.points.length) {
    return rules;
  }

  const byId = new Map<string, TalkingPoint>();
  for (const r of rules) byId.set(r.id, r);

  const out: TalkingPoint[] = [];
  for (const p of result.points) {
    if (!p || typeof p !== "object") continue;
    const id = typeof p.id === "string" ? p.id : "";
    const original = byId.get(id);
    if (!original) continue;
    const kind: TalkingPointKind = VALID_KINDS.has(p.kind as TalkingPointKind)
      ? (p.kind as TalkingPointKind)
      : original.kind;
    const headline = typeof p.headline === "string" && p.headline.trim()
      ? p.headline.trim().slice(0, 80)
      : original.headline;
    const detail = typeof p.detail === "string" && p.detail.trim()
      ? p.detail.trim()
      : original.detail;
    let supporting_metric = original.supporting_metric;
    if (
      p.supporting_metric &&
      typeof p.supporting_metric.label === "string" &&
      typeof p.supporting_metric.value === "string"
    ) {
      supporting_metric = {
        label: p.supporting_metric.label,
        value: p.supporting_metric.value,
      };
    }
    out.push({ id, kind, headline, detail, supporting_metric });
  }

  // If the LLM dropped some points, fall back to originals for the missing ids
  // (preserve full list, in the original order).
  const seen = new Set(out.map((p) => p.id));
  const merged: TalkingPoint[] = [];
  for (const r of rules) {
    if (seen.has(r.id)) {
      merged.push(out.find((p) => p.id === r.id)!);
    } else {
      merged.push(r);
    }
  }
  return merged;
}
