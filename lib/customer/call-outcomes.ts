import { getSql } from "./postgres";
import type { ScoredCustomerV2 } from "./types";

/**
 * F-call-outcome — AM-marked call result per customer.
 *
 * After an AM rings a customer they can flag the outcome as Connected, VM, or
 * Not connected. The marker lives for 7 days and shows on the customer card so
 * every AM looking at the account knows the state of the latest attempt.
 *
 * Special rule for "connected":
 *   The customer's effective tier is demoted to MONITOR (Watch) for the
 *   duration of the 7-day window. If the underlying tier is HEALTHY, no
 *   change. Anything CRITICAL/AT-RISK/MONITOR is forced to MONITOR or
 *   HEALTHY depending on signals_v2.composite. This keeps a just-called
 *   customer off the "needs a call" stack until the window expires.
 *
 * One row per entity_id — re-marking REPLACES the existing outcome and resets
 * the 7-day clock. Schema self-heals via ensureCallOutcomesSchema().
 */

export type CallOutcomeKind = "connected" | "vm" | "not_connected";

export type CallOutcomeRow = {
  entity_id: string;
  outcome: CallOutcomeKind;
  marked_at: string;
  marked_by_email: string;
  marked_by_name: string | null;
  expires_at: string;
};

export const OUTCOME_TTL_DAYS = 7;

let _outcomesReady = false;

async function ensureCallOutcomesSchema(): Promise<boolean> {
  if (_outcomesReady) return true;
  const sql = getSql();
  if (!sql) return false;
  await sql`
    CREATE TABLE IF NOT EXISTS customer_call_outcomes (
      entity_id        TEXT PRIMARY KEY,
      outcome          TEXT NOT NULL CHECK (outcome IN ('connected','vm','not_connected')),
      marked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      marked_by_email  TEXT NOT NULL,
      marked_by_name   TEXT,
      expires_at       TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_call_outcomes_expires ON customer_call_outcomes(expires_at)`;
  _outcomesReady = true;
  return true;
}

function toIso(v: string | Date): string {
  return typeof v === "string" ? v : v.toISOString();
}

/**
 * Upsert a call outcome. Replaces any existing row for this entity, resetting
 * marked_at + expires_at. Returns the row so the client can render the pill
 * with the fresh countdown immediately.
 */
export async function markCallOutcome(args: {
  entityId: string;
  outcome: CallOutcomeKind;
  markedByEmail: string;
  markedByName?: string | null;
}): Promise<CallOutcomeRow> {
  const ready = await ensureCallOutcomesSchema();
  if (!ready) {
    throw new Error(
      "[call-outcomes] POSTGRES_URL not configured — cannot persist outcome",
    );
  }
  const sql = getSql();
  if (!sql) {
    throw new Error(
      "[call-outcomes] POSTGRES_URL not configured — cannot persist outcome",
    );
  }
  // Compute expires_at in JS to avoid timezone surprises across regions.
  const expiresIso = new Date(
    Date.now() + OUTCOME_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const rows = await sql`
    INSERT INTO customer_call_outcomes (
      entity_id, outcome, marked_at, marked_by_email, marked_by_name, expires_at
    ) VALUES (
      ${args.entityId},
      ${args.outcome},
      NOW(),
      ${args.markedByEmail},
      ${args.markedByName ?? null},
      ${expiresIso}
    )
    ON CONFLICT (entity_id) DO UPDATE SET
      outcome = EXCLUDED.outcome,
      marked_at = NOW(),
      marked_by_email = EXCLUDED.marked_by_email,
      marked_by_name = EXCLUDED.marked_by_name,
      expires_at = EXCLUDED.expires_at
    RETURNING entity_id, outcome, marked_at, marked_by_email, marked_by_name, expires_at
  `;
  const r = rows[0] as {
    entity_id: string;
    outcome: CallOutcomeKind;
    marked_at: string | Date;
    marked_by_email: string;
    marked_by_name: string | null;
    expires_at: string | Date;
  };
  return {
    entity_id: r.entity_id,
    outcome: r.outcome,
    marked_at: toIso(r.marked_at),
    marked_by_email: r.marked_by_email,
    marked_by_name: r.marked_by_name ?? null,
    expires_at: toIso(r.expires_at),
  };
}

/** Delete any outcome row for this entity. Idempotent. Used for "Clear" UI. */
export async function clearCallOutcome(entityId: string): Promise<void> {
  const ready = await ensureCallOutcomesSchema();
  if (!ready) return;
  const sql = getSql();
  if (!sql) return;
  await sql`DELETE FROM customer_call_outcomes WHERE entity_id = ${entityId}`;
}

/**
 * Bulk-fetch every active outcome (expires_at > NOW). Returned as a Map keyed
 * on entity_id for O(1) joining onto the snapshot's customers[].
 */
export async function getActiveCallOutcomes(): Promise<Map<string, CallOutcomeRow>> {
  const out = new Map<string, CallOutcomeRow>();
  const ready = await ensureCallOutcomesSchema();
  if (!ready) return out;
  const sql = getSql();
  if (!sql) return out;
  const rows = await sql`
    SELECT entity_id, outcome, marked_at, marked_by_email, marked_by_name, expires_at
    FROM customer_call_outcomes
    WHERE expires_at > NOW()
  `;
  for (const r of rows as Array<{
    entity_id: string;
    outcome: CallOutcomeKind;
    marked_at: string | Date;
    marked_by_email: string;
    marked_by_name: string | null;
    expires_at: string | Date;
  }>) {
    out.set(r.entity_id, {
      entity_id: r.entity_id,
      outcome: r.outcome,
      marked_at: toIso(r.marked_at),
      marked_by_email: r.marked_by_email,
      marked_by_name: r.marked_by_name ?? null,
      expires_at: toIso(r.expires_at),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tier-override helpers
// ---------------------------------------------------------------------------

/**
 * Pure helper. Given a snapshot customer and (optionally) their active call
 * outcome, returns the customer with two things mutated:
 *
 *  1. `.call_outcome` field populated (so the UI can render the pill).
 *  2. If outcome === 'connected' AND not expired:
 *     - metabase_health.health_tier promoted DOWN to MONITOR (Watch) unless
 *       the raw tier is already HEALTHY (in which case stay HEALTHY).
 *     - signals_v2.stoplight RED → YELLOW; signals_v2.tier HIGH → MEDIUM.
 *     - The raw values are preserved on `_raw_health_tier` / `_raw_stoplight`
 *       / `_raw_signals_tier` for debugging.
 *
 * VM and Not-connected DO NOT override tier — the AM still needs to follow
 * up so the customer remains on the at-risk stack. They only get the pill.
 *
 * Idempotent — calling twice produces the same result. Pure — no DB hits.
 */
export function applyOutcomeOverride(
  customer: ScoredCustomerV2,
  outcome: CallOutcomeRow | undefined,
): ScoredCustomerV2 {
  if (!outcome) return customer;
  const expiresMs = Date.parse(outcome.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return customer;

  // Strip entity_id from the outcome — the customer carries its own.
  const decorated: ScoredCustomerV2 = {
    ...customer,
    call_outcome: {
      outcome: outcome.outcome,
      marked_at: outcome.marked_at,
      marked_by_email: outcome.marked_by_email,
      marked_by_name: outcome.marked_by_name,
      expires_at: outcome.expires_at,
    },
  };

  if (outcome.outcome !== "connected") return decorated;

  // Connected — downgrade for the rest of the 7-day window.
  // Idempotency: if a prior call already overrode this customer, read the
  // PRE-override tier from `_raw_health_tier` so re-applying doesn't cascade
  // (e.g. CRITICAL → MONITOR → HEALTHY across two calls).
  const existingHealth = (customer as ScoredCustomerV2 & {
    metabase_health?: {
      health_tier?: string | null;
      _raw_health_tier?: string | null;
      _override_reason?: string | null;
    };
  }).metabase_health;
  const wasOverriddenAlready =
    existingHealth?._override_reason === "call_outcome_connected";
  const rawTier = String(
    (wasOverriddenAlready
      ? existingHealth?._raw_health_tier ?? ""
      : existingHealth?.health_tier ?? "") ?? "",
  ).toUpperCase();
  const isHealthy = rawTier === "HEALTHY";
  const needsDemotion =
    rawTier === "CRITICAL" ||
    rawTier === "CRITICAL - DEAL BREAKER" ||
    rawTier === "AT-RISK" ||
    rawTier === "MONITOR" ||
    rawTier === "";

  if (!needsDemotion || isHealthy) {
    // Already HEALTHY — nothing to override. Pill still renders.
    return decorated;
  }

  // For currently MONITOR customers, a successful call usually means they're
  // landing healthy for the window. For CRITICAL/AT-RISK we hold at MONITOR
  // (Watch) — the underlying signal is still bad, the call was a touchpoint.
  const demotedTier: "MONITOR" | "HEALTHY" =
    rawTier === "MONITOR" ? "HEALTHY" : "MONITOR";

  const rawHealth = (decorated as ScoredCustomerV2 & {
    metabase_health?: Record<string, unknown> | null;
  }).metabase_health;

  // metabase_health is decorated at read time (snapshot route), not part of
  // the ScoredCustomerV2 type — cast through unknown to mutate.
  const overridden = {
    ...decorated,
    signals_v2: {
      ...customer.signals_v2,
      stoplight:
        customer.signals_v2.stoplight === "RED"
          ? "YELLOW"
          : customer.signals_v2.stoplight,
      tier:
        customer.signals_v2.tier === "HIGH"
          ? "MEDIUM"
          : customer.signals_v2.tier,
    },
  } as unknown as ScoredCustomerV2 & {
    metabase_health?: Record<string, unknown> | null;
  };
  overridden.metabase_health = {
    ...(rawHealth || {}),
    health_tier: demotedTier,
    _raw_health_tier: rawTier || null,
    _override_reason: "call_outcome_connected",
  };
  return overridden;
}

/**
 * Bulk overlay. Reads active outcomes once, then maps the customer array
 * through `applyOutcomeOverride`. Call this anywhere a downstream consumer
 * reads `snapshot.customers` (snapshot route, slack-digest, AI context, inbox,
 * monday-brief).
 */
export async function enrichWithCallOutcomes(
  customers: ScoredCustomerV2[],
): Promise<ScoredCustomerV2[]> {
  const outcomes = await getActiveCallOutcomes().catch((e) => {
    console.warn(
      "[call-outcomes] enrich skipped:",
      e instanceof Error ? e.message : String(e),
    );
    return new Map<string, CallOutcomeRow>();
  });
  if (outcomes.size === 0) return customers;
  return customers.map((c) => applyOutcomeOverride(c, outcomes.get(c.entity_id)));
}
