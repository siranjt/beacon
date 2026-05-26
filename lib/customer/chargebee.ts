import type { ChargebeeSub } from "./types";

/**
 * Paginate Chargebee /subscriptions across `active`, `non_renewing`, `in_trial`
 * and return a deduped list. Calls are made serially (one per status,
 * 100 per page) to respect Chargebee's rate limits.
 *
 * v2: also extracts cf_entity_id (the Zoca location bound to each
 * subscription) — exposed via `fetchActiveCustomerEntityMap()`.
 */
export async function fetchAllLiveSubs(): Promise<ChargebeeSub[]> {
  const { subs } = await fetchAllLiveSubsWithEntityMap();
  return subs;
}

/**
 * v2 extension — returns both the deduped subscription list and a
 * customer_id → entity_ids[] map (from cf_entity_id custom fields).
 *
 * Used by Phase 1 to build the active-customer universe (~922 entities)
 * without depending on BaseSheet for the entity link.
 */
export async function fetchAllLiveSubsWithEntityMap(): Promise<{
  subs: ChargebeeSub[];
  customerToEntities: Map<string, string[]>;
  // Phase 33.scope-fix7 — per-entity name from Chargebee cf_entity_name custom field.
  entityNameById: Map<string, string>;
}> {
  const site = process.env.CHARGEBEE_SITE || "zoca";
  const key = process.env.CHARGEBEE_API_KEY;
  if (!key) throw new Error("CHARGEBEE_API_KEY is not set");

  const base = `https://${site}.chargebee.com/api/v2`;
  const authHeader = "Basic " + Buffer.from(`${key}:`).toString("base64");

  const out: ChargebeeSub[] = [];
  const seen = new Set<string>();
  const customerToEntities = new Map<string, Set<string>>();
  // Phase 33.scope-fix7 — per-entity name (cf_entity_name from sub custom field).
  const entityNameById = new Map<string, string>();

  // v2 — include "future" so AMs can see upcoming signed customers.
  // TODO: future subs hit the scoring engine with zero comms/usage/billing
  // and look like worst-case churning customers; they peg HIGH/RED. Phase 8
  // should add a 'pre-launch' state in scoring keyed off activated_at being
  // null or in the future, distinct from the RED stoplight.
  for (const status of ["active", "non_renewing", "in_trial", "future"] as const) {
    let offset: string | undefined;
    let page = 0;
    do {
      const params = new URLSearchParams();
      params.set("limit", "100");
      params.set("status[is]", status);
      if (offset) params.set("offset", offset);

      const res = await fetch(`${base}/subscriptions?${params.toString()}`, {
        method: "GET",
        headers: { Authorization: authHeader },
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Chargebee ${status} ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        list: { subscription: any; customer: any }[];
        next_offset?: string;
      };
      for (const item of data.list || []) {
        const sub = item.subscription || {};
        const cust = item.customer || {};
        const customer_id = sub.customer_id || cust.id;
        if (!customer_id || seen.has(customer_id + "::" + sub.id)) continue;
        seen.add(customer_id + "::" + sub.id);

        // v2 — capture cf_entity_id (entity bound to this subscription)
        const cfEntityId = sub.cf_entity_id || "";
        if (cfEntityId) {
          const set = customerToEntities.get(customer_id) || new Set<string>();
          set.add(cfEntityId);
          customerToEntities.set(customer_id, set);
          // Phase 33.scope-fix7 — capture per-entity name from sub custom field.
          const cfEntityName = (sub.cf_entity_name || "").toString().trim();
          if (cfEntityName) entityNameById.set(cfEntityId, cfEntityName);
        }

        out.push({
          subscription_id: sub.id || "",
          customer_id,
          status: sub.status || status,
          plan_amount: Number(sub.plan_amount || sub.mrr || 0),
          created_at: sub.created_at ? Number(sub.created_at) * 1000 : null,
          activated_at: sub.activated_at ? Number(sub.activated_at) * 1000 : null,
          auto_collection: cust.auto_collection || sub.auto_collection || null,
          email: cust.email || null,
          first_name: cust.first_name || null,
          last_name: cust.last_name || null,
          company: cust.company || null,
          phone: cust.phone || null,
        });
      }
      offset = data.next_offset;
      page++;
      if (page > 80) break;
    } while (offset);
  }


  // Phase 33.scope: second pass — cancelled subs within the last 30 days.
  // These power the "recently churned (30d retention)" lifecycle bucket.
  // We dedupe against the live universe; if a customer_id has BOTH a live
  // sub AND a recently-cancelled sub (resurrection case), the live sub
  // stays as the primary row in `out` and the cancelled marker is carried
  // on a SEPARATE row appended with `recently_cancelled: true`.
  {
    const cutoffSec = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    let offset: string | undefined;
    let page = 0;
    do {
      const params = new URLSearchParams();
      params.set("limit", "100");
      params.set("status[is]", "cancelled");
      params.set("cancelled_at[after]", String(cutoffSec));
      if (offset) params.set("offset", offset);

      const res = await fetch(`${base}/subscriptions?${params.toString()}`, {
        method: "GET",
        headers: { Authorization: authHeader },
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Chargebee cancelled ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        list: { subscription: any; customer: any }[];
        next_offset?: string;
      };
      for (const item of data.list || []) {
        const sub = item.subscription || {};
        const cust = item.customer || {};
        const customer_id = sub.customer_id || cust.id;
        if (!customer_id) continue;
        const key = customer_id + "::" + sub.id;
        if (seen.has(key)) continue;
        seen.add(key);

        const cfEntityId = sub.cf_entity_id || "";
        if (cfEntityId) {
          const set = customerToEntities.get(customer_id) || new Set<string>();
          set.add(cfEntityId);
          customerToEntities.set(customer_id, set);
          // Phase 33.scope-fix7 — capture per-entity name (cancelled subs may have it too).
          const cfEntityName = (sub.cf_entity_name || "").toString().trim();
          if (cfEntityName) entityNameById.set(cfEntityId, cfEntityName);
        }

        out.push({
          subscription_id: sub.id || "",
          customer_id,
          status: sub.status || "cancelled",
          plan_amount: Number(sub.plan_amount || sub.mrr || 0),
          created_at: sub.created_at ? Number(sub.created_at) * 1000 : null,
          activated_at: sub.activated_at ? Number(sub.activated_at) * 1000 : null,
          cancelled_at: sub.cancelled_at ? Number(sub.cancelled_at) * 1000 : null,
          recently_cancelled: true,
          auto_collection: cust.auto_collection || sub.auto_collection || null,
          email: cust.email || null,
          first_name: cust.first_name || null,
          last_name: cust.last_name || null,
          company: cust.company || null,
          phone: cust.phone || null,
        });
      }
      offset = data.next_offset;
      page++;
      if (page > 80) break;
    } while (offset);
  }

  // Phase 33.scope-fix3 — surface the cancelled-30d fetch outcome in Vercel logs.
  // Caveat: _cancelledWithCfEntity over-counts when a customer has BOTH live and
  // cancelled subs (resurrected case) — customerToEntities holds both. Diagnostic
  // only; we can tighten later if needed.
  let _cancelledTotalSubs = 0;
  let _cancelledWithCfEntity = 0;
  let _cancelledDistinctEntities = new Set<string>();
  for (const s of out) {
    if ((s as any).recently_cancelled) {
      _cancelledTotalSubs++;
      if (s.customer_id && customerToEntities.has(s.customer_id)) {
        _cancelledWithCfEntity++;
        for (const eid of customerToEntities.get(s.customer_id)!) _cancelledDistinctEntities.add(eid);
      }
    }
  }
  console.log(
    `[chargebee] cancelled-30d fetch: ${_cancelledTotalSubs} subs, ` +
    `${_cancelledWithCfEntity} matched to customer\u2192entity map, ` +
    `${_cancelledDistinctEntities.size} distinct entity_ids`
  );

  // Convert Set values to sorted arrays for stable output
  const customerToEntitiesArr = new Map<string, string[]>();
  for (const [c, s] of customerToEntities) {
    customerToEntitiesArr.set(c, Array.from(s).sort());
  }

  // Phase 33.scope-fix7 — return per-entity name lookup alongside the entity-id map.
  return { subs: out, customerToEntities: customerToEntitiesArr, entityNameById };
}

/**
 * Phase E-19.1a — thin wrapper that returns just the active-entity universe
 * as a sorted, deduped string[] for callers that don't need the full sub
 * payload (scale tests, bulk-comms scheduling, parity harnesses, ad-hoc
 * ops scripts).
 *
 * Mirrors Stage B's exact logic: derives entity_ids from each subscription's
 * `cf_entity_id` custom field across active + non_renewing + in_trial + future.
 * Excludes the recently-cancelled (30d) bucket — those entities are tracked
 * separately for retention/resurrected detection.
 *
 * Also returns a `meta` object with:
 *   - subsWithoutEntity: subscriptions that have no cf_entity_id binding —
 *     real ops data hole; surface to alerting if non-zero.
 *   - statusBreakdown: count per status, useful for the "live and correct"
 *     freshness assertion the dashboard makes.
 *
 * NOT cached — the whole point is that the active set must be live-current.
 * Callers wanting cheap repeat reads inside one request should hold the
 * return value in a local.
 */
export async function fetchLiveActiveEntityIds(): Promise<{
  entityIds: string[];
  meta: {
    totalSubs: number;
    statusBreakdown: Record<string, number>;
    subsWithoutEntity: { customer_id: string; subscription_id: string; status: string }[];
    uniqueCustomers: number;
    multiEntityCustomers: number;
  };
}> {
  const { subs, customerToEntities } = await fetchAllLiveSubsWithEntityMap();

  // Drop the recently-cancelled rows — those are the retention bucket, not
  // the live universe. They share customer_id with live subs in the
  // resurrected case, which we don't want fanning into the active set.
  const liveSubs = subs.filter((s) => !(s as any).recently_cancelled);

  const entityIds = new Set<string>();
  const statusBreakdown: Record<string, number> = {};
  const subsWithoutEntity: { customer_id: string; subscription_id: string; status: string }[] = [];

  for (const s of liveSubs) {
    statusBreakdown[s.status] = (statusBreakdown[s.status] || 0) + 1;
    const ents = customerToEntities.get(s.customer_id) || [];
    if (ents.length === 0) {
      subsWithoutEntity.push({
        customer_id: s.customer_id,
        subscription_id: s.subscription_id,
        status: s.status,
      });
      continue;
    }
    for (const eid of ents) entityIds.add(eid);
  }

  let multiEntityCustomers = 0;
  for (const [, ents] of customerToEntities) {
    if (ents.length > 1) multiEntityCustomers++;
  }

  return {
    entityIds: Array.from(entityIds).sort(),
    meta: {
      totalSubs: liveSubs.length,
      statusBreakdown,
      subsWithoutEntity,
      uniqueCustomers: customerToEntities.size,
      multiEntityCustomers,
    },
  };
}
