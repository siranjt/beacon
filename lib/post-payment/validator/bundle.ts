/**
 * Validator orchestrator — TS port of the deterministic half of payment_validator.py.
 *
 * Given a Chargebee customer_id, builds a Bundle: the same JSON structure the
 * Python validator produced. The bundle becomes the input to the LLM evaluator,
 * which then produces the structured report JSON for the Word-doc renderer.
 */

import * as cb from "./chargebee";
import * as stripe from "./stripe";
import * as mb from "./metabase";

export type Bundle = {
  customer_id: string;
  chargebee_customer: any;
  stripe_customer: any | null;
  t_created_unix: number;
  t_created_iso: string;
  t_chargebee_unix: number;
  t_stripe_unix: number | null;
  timestamp_mismatch_hours: number | null;
  timestamp_mismatch_flag: boolean;
  subscription: any | null;
  is_first_subscription: boolean;
  discovery_match: boolean;
  discovery_item_prices: string[];
  invoices: any[];
  discounts_applied: any[];
  entities: Record<string, string>[];
  entity_ids: string[];
  comms: mb.CommsResult;
  comms_summary: Record<string, number>;
  comms_window_start_unix: number;
  comms_window_end_unix: number;
  // enrichment
  booking_platform_rows: Record<string, string>[];
  opening_date_rows: Record<string, string>[];
  review_metrics: Record<string, string> | null;
  // sanity flags
  pre_floor: boolean;
  skip_reason: string | null;
};

const FLOOR_DATE = process.env.CUSTOMER_FLOOR_DATE ?? "2026-05-01";
const DISCOVERY_PATTERN = (process.env.DISCOVERY_FILTER_PATTERN ?? "discovery").toLowerCase();
const COMMS_WINDOW_DAYS = Number(process.env.COMMS_WINDOW_DAYS ?? 90);
const TIMESTAMP_MISMATCH_HOURS = Number(process.env.TIMESTAMP_MISMATCH_HOURS ?? 24);

/**
 * Build the "light" half of the bundle — everything except the 5 comms CSVs.
 * Designed to complete in <40s on Vercel Hobby (60s function cap).
 * Returns a partial bundle with empty `comms` / `comms_summary`. Stage 2 fills
 * those in.
 */
export async function buildBundleLight(customerId: string): Promise<Bundle> {
  return buildBundleInternal(customerId, /* includeComms */ false);
}

/**
 * Full bundle build — kept for backfill / single-shot scripts that don't care
 * about function-timeout limits. Production webhook flow uses the staged path.
 */
export async function buildBundle(customerId: string): Promise<Bundle> {
  return buildBundleInternal(customerId, /* includeComms */ true);
}

async function buildBundleInternal(customerId: string, includeComms: boolean): Promise<Bundle> {
  const customer = await cb.getCustomer(customerId);
  const tChargebee = Number(customer.created_at ?? 0);

  // Floor check
  const floorUnix = Math.floor(new Date(`${FLOOR_DATE}T00:00:00Z`).getTime() / 1000);
  const preFloor = tChargebee < floorUnix;

  // Subscriptions for this customer
  const subs = await cb.listSubscriptionsForCustomer(customerId);
  const earliestSub = subs.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))[0] ?? null;

  // Discovery match on the earliest sub
  let isDiscovery = false;
  let matchedItems: string[] = [];
  if (earliestSub) {
    for (const item of earliestSub.subscription_items ?? []) {
      const ipid = (item.item_price_id ?? "").toLowerCase();
      if (ipid.includes(DISCOVERY_PATTERN)) matchedItems.push(item.item_price_id);
    }
    isDiscovery = matchedItems.length > 0;
  }

  // Stripe match by email
  const stripeCustomer = customer.email ? await stripe.findCustomerByEmail(customer.email) : null;
  const tStripe = stripeCustomer && typeof stripeCustomer.created === "number" ? stripeCustomer.created : null;
  const tCreated = tStripe !== null ? Math.min(tChargebee, tStripe) : tChargebee;
  const diffHours = tStripe !== null ? Math.abs(tChargebee - tStripe) / 3600 : null;
  const mismatchFlag = diffHours !== null && diffHours > TIMESTAMP_MISMATCH_HOURS;

  // Invoices for the earliest sub
  const invoices = earliestSub ? await cb.listInvoicesForSubscription(earliestSub.id) : [];
  const discounts: any[] = [];
  for (const inv of invoices) {
    for (const d of inv.discounts ?? []) discounts.push({ invoice_id: inv.id, ...d });
    for (const li of inv.line_item_discounts ?? []) discounts.push({ invoice_id: inv.id, ...li });
  }

  // BaseSheet → entities for this customer.
  // Fallback path: if BaseSheet hasn't synced this customer yet (common for
  // freshly-paid customers — Metabase sync lags real-time payments by hours
  // or more), use the cf_entity_id custom field on the Chargebee customer
  // record. Chargebee stores it at the moment of customer creation, so it's
  // always available without waiting for downstream sync. The BaseSheet read
  // remains the authoritative source when present (richer fields: AM/AE,
  // lead source, primary category, etc.).
  const entities = await mb.basesheetForCustomer(customerId);
  let entityIds = entities.map(e => e.entity_id).filter(Boolean);
  if (entityIds.length === 0 && customer.cf_entity_id) {
    entityIds = [customer.cf_entity_id];
    // Synthesize a minimal entity record so downstream code that expects
    // entities[0].entity_name / .biz_name still finds something. BaseSheet's
    // richer columns (AE/AM, lead source, etc.) will simply be undefined,
    // and the LLM prompt handles that gracefully.
    entities.push({
      entity_id: customer.cf_entity_id,
      bizname: customer.cf_entity_name ?? customer.company ?? "",
      source: "chargebee_cf_fallback",
    } as any);
  }
  const firstEntityId = entityIds[0];

  // Comms — heavy step (~40s), skipped on light builds (Stage 2 fills these in)
  let comms: mb.CommsResult = {};
  if (includeComms && entityIds.length) {
    comms = await mb.commsForEntities({
      entityIds: new Set(entityIds), cutoffUnix: tCreated, windowDays: COMMS_WINDOW_DAYS,
    });
  }
  const commsSummary: Record<string, number> = {};
  for (const [k, v] of Object.entries(comms)) commsSummary[k.replace(/^comms_/, "")] = v.length;

  // Enrichment per entity (use first entity)
  let bookingRows: Record<string, string>[] = [];
  let openingRows: Record<string, string>[] = [];
  let reviewMetrics: Record<string, string> | null = null;
  if (firstEntityId) {
    [bookingRows, openingRows, reviewMetrics] = await Promise.all([
      mb.bookingPlatformForEntity(firstEntityId),
      mb.openingDateForEntity(firstEntityId),
      mb.reviewMetricsForEntity(firstEntityId),
    ]);
  }

  let skipReason: string | null = null;
  if (preFloor) skipReason = `customer_created_before_floor (${new Date(tChargebee * 1000).toISOString()} < ${FLOOR_DATE})`;
  else if (!earliestSub) skipReason = "no_subscriptions";
  else if (!isDiscovery) skipReason = "first_sub_not_discovery";

  return {
    customer_id: customerId,
    chargebee_customer: customer,
    stripe_customer: stripeCustomer,
    t_created_unix: tCreated,
    t_created_iso: new Date(tCreated * 1000).toISOString(),
    t_chargebee_unix: tChargebee,
    t_stripe_unix: tStripe,
    timestamp_mismatch_hours: diffHours,
    timestamp_mismatch_flag: mismatchFlag,
    subscription: earliestSub,
    is_first_subscription: !!earliestSub,
    discovery_match: isDiscovery,
    discovery_item_prices: matchedItems,
    invoices,
    discounts_applied: discounts,
    entities,
    entity_ids: entityIds,
    comms,
    comms_summary: commsSummary,
    comms_window_start_unix: tCreated - COMMS_WINDOW_DAYS * 86400,
    comms_window_end_unix: tCreated,
    booking_platform_rows: bookingRows,
    opening_date_rows: openingRows,
    review_metrics: reviewMetrics,
    pre_floor: preFloor,
    skip_reason: skipReason,
  };
}
