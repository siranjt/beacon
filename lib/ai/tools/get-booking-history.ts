/**
 * get_booking_history — Beam tool. META-A3 (2026-06-11).
 *
 * Pulls live booking-enquiry (lead) data for one customer over a sliding
 * window from the operational Postgres warehouse (db=2). Answers questions
 * like "how many bookings did Acme get last month?" / "what's their
 * conversion rate?" / "where are leads coming from?".
 *
 * Source of truth: website.booking_enquiries (the same table that
 * powers the Performance Report). A `booking_id` value indicates the
 * lead converted into a booking.
 *
 * Read-only. Cached for 5 min in-process. Soft-fails to an empty
 * response when Metabase is unreachable so the model still gets a
 * usable tool_result.
 */

import { runQuery, DB } from "@/lib/metabase";
import { logUmbrellaActivity } from "@/lib/activity/log";
import { getCachedContext, makeCacheKey } from "@/lib/ai/context-cache";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 365;
const MIN_WINDOW_DAYS = 1;
const CACHE_TTL_MS = 5 * 60 * 1000;
const RECENT_LIMIT = 5;

type BookingRow = {
  id: string;
  created_at: string;
  status: string | null;
  utm_source: string | null;
  booking_id: string | null;
  first_name: string | null;
  service: string | null;
} & Record<string, unknown>;

/**
 * SQL — FROM website.booking_enquiries WHERE entity_id=:eid AND
 * created_at >= now() - :days days AND is_test_lead = false.
 * Ordered desc, capped at 500 rows (we only need counts + 5 recent).
 */
const SQL_BOOKING_HISTORY = `
SELECT
  id::text AS id,
  created_at::text AS created_at,
  status,
  utm_source,
  booking_id::text AS booking_id,
  attributes->>'first_name' AS first_name,
  service
FROM website.booking_enquiries
WHERE entity_id = {{entity_id}}::uuid
  AND is_test_lead = false
  AND created_at >= NOW() - ({{window_days}}::int * INTERVAL '1 day')
ORDER BY created_at DESC
LIMIT 500
`;

interface BookingHistorySummary {
  entity_id: string;
  window_days: number;
  found: boolean;
  leads_total: number;
  leads_converted_to_booking: number;
  conversion_rate: number;
  top_utm_source: string | null;
  utm_source_breakdown: Array<{ source: string; count: number }>;
  recent_5_leads: Array<{
    id: string;
    created_at: string;
    status: string | null;
    utm_source: string | null;
    service: string | null;
    first_name: string | null;
    converted: boolean;
  }>;
}

async function fetchBookingHistory(
  entityId: string,
  windowDays: number,
): Promise<BookingHistorySummary> {
  const rows = await runQuery<BookingRow>({
    database: DB.POSTGRES,
    sql: SQL_BOOKING_HISTORY,
    params: { entity_id: entityId, window_days: windowDays },
  });

  if (rows.length === 0) {
    return {
      entity_id: entityId,
      window_days: windowDays,
      found: false,
      leads_total: 0,
      leads_converted_to_booking: 0,
      conversion_rate: 0,
      top_utm_source: null,
      utm_source_breakdown: [],
      recent_5_leads: [],
    };
  }

  let converted = 0;
  const sourceCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.booking_id) converted += 1;
    const src = (r.utm_source || "(unknown)").trim() || "(unknown)";
    sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
  }

  const sourceBreakdown = Array.from(sourceCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([source, count]) => ({ source, count }));

  const recent = rows.slice(0, RECENT_LIMIT).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    status: r.status,
    utm_source: r.utm_source,
    service: r.service,
    first_name: r.first_name,
    converted: !!r.booking_id,
  }));

  return {
    entity_id: entityId,
    window_days: windowDays,
    found: true,
    leads_total: rows.length,
    leads_converted_to_booking: converted,
    conversion_rate:
      rows.length > 0 ? Math.round((converted / rows.length) * 10000) / 100 : 0,
    top_utm_source: sourceBreakdown[0]?.source ?? null,
    utm_source_breakdown: sourceBreakdown,
    recent_5_leads: recent,
  };
}

export const getBookingHistoryTool: BeaconTool = {
  name: "get_booking_history",
  description:
    "Live lead/booking pull for ONE customer from Postgres (website.booking_enquiries) over a sliding window (default 90 days). Returns total leads, how many converted to bookings, conversion rate, top utm_source mix, and the most recent 5 leads. Read-only, in-process 5-min cache. Soft-fails to found=false on empty data and on Metabase outage.\n" +
    "Trigger phrases: \"how many leads in last 30 days?\", \"what's their conversion rate?\", \"where are bookings coming from?\", \"any recent leads?\", \"top lead source?\".",
  input_schema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description:
          "The customer's entity_id (UUID). Resolve via lookup_customer or from CONTEXT first.",
        minLength: 8,
      },
      window_days: {
        type: "integer",
        description: `Sliding window in days. Default ${DEFAULT_WINDOW_DAYS}. Min 1, max ${MAX_WINDOW_DAYS}.`,
        minimum: MIN_WINDOW_DAYS,
        maximum: MAX_WINDOW_DAYS,
      },
    },
    required: ["entity_id"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const entityId =
      typeof args.entity_id === "string" ? args.entity_id.trim() : "";
    if (!entityId) {
      return { ok: false, error: "entity_id is required" };
    }

    const rawWindow =
      typeof args.window_days === "number" ? Math.floor(args.window_days) : NaN;
    const windowDays =
      Number.isFinite(rawWindow) && rawWindow >= MIN_WINDOW_DAYS
        ? Math.min(rawWindow, MAX_WINDOW_DAYS)
        : DEFAULT_WINDOW_DAYS;

    const cacheKey = makeCacheKey("booking-history", {
      entity: entityId,
      window: windowDays,
    });

    try {
      const data = await getCachedContext(
        cacheKey,
        () => fetchBookingHistory(entityId, windowDays),
        { ttlMs: CACHE_TTL_MS },
      );

      const summary = data.found
        ? `Entity ${entityId.slice(0, 8)} — ${data.leads_total} leads in last ${windowDays}d, ` +
          `${data.leads_converted_to_booking} booked (${data.conversion_rate}%), ` +
          `top source: ${data.top_utm_source ?? "n/a"}.`
        : `No booking data for entity ${entityId.slice(0, 8)} in the last ${windowDays} days.`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:get_booking_history",
        surface: "customer-360",
        entity_id: entityId,
        metadata: {
          tool: "get_booking_history",
          window_days: windowDays,
          leads_total: data.leads_total,
          converted: data.leads_converted_to_booking,
          conversion_rate: data.conversion_rate,
          top_source: data.top_utm_source,
        },
      });

      return { ok: true, summary, data: data as unknown as Record<string, unknown> };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: `Booking history fetch failed: ${msg.slice(0, 200)}`,
      };
    }
  },
};
