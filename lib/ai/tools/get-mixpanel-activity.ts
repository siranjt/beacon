/**
 * get_mixpanel_activity — Beam tool. META-A3 (2026-06-11).
 *
 * Pulls live Mixpanel app-activity for ONE customer from the Aurora warehouse
 * (`mixpanelzocaappdata.export`, db=7). Answers questions like "are they
 * opening the Zoca app?" / "are they marking leads?" / "are they sending
 * review invites?".
 *
 * IMPORTANT JOIN KEY:
 *   Mixpanel events are keyed on `"locationEntityId"` (camelCase, quoted)
 *   in the export table. Using `entityId` or `businessEntityId` returns
 *   zero rows — verified in CLAUDE.md project memory. Coverage: 919 of 927
 *   active customers (99%) have Mixpanel rows in the last 90 days; the 8
 *   without are themselves a dormant-engagement signal.
 *
 * Engagement tier (30-day default window):
 *   active   → app_opens > 20
 *   light    → 5 <= app_opens <= 20
 *   cold     → 1 <= app_opens <= 4
 *   dormant  → app_opens == 0
 *
 * Read-only. Cached for 5 min in-process. Soft-fails to empty data on
 * Metabase outage so the model can recover.
 */

import { runQuery, DB } from "@/lib/metabase";
import { logUmbrellaActivity } from "@/lib/activity/log";
import { getCachedContext, makeCacheKey } from "@/lib/ai/context-cache";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 180;
const MIN_WINDOW_DAYS = 1;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Per CLAUDE.md memory — canonical mapping of Mixpanel event names → behavior:
 *   App/Site Opened              → app opens
 *   $ae_session                  → session days (count distinct)
 *   Leads-Select-LeadStatusSheet → lead marked (won/lost/contacted/etc.)
 *   Leads-Click-LeadContact      → outbound contact attempt
 *   Leads-Click-ChatCall         → outbound contact attempt
 *   Leads-Click-DetailCopyNumber → outbound contact attempt
 *   Review-Click-SendInviteSingle → review invite sent
 *   Reviews-Click-ReviewReplyAI   → review reply
 *   Reviews-Done-ReviewReply     → review reply completed
 *
 * Schema gotcha: `mixpanelzocaappdata.export` is FLAT (one column per
 * Mixpanel property — NOT a `properties` JSONB column). The join key
 * `locationEntityId` is a real text column. It must be double-quoted
 * because Postgres folds unquoted identifiers to lowercase. Both `event`
 * (text) and `"time"` (timestamptz) are real columns; `"time"` is quoted
 * because it shadows the SQL reserved word. (Verified 2026-06-11.)
 */
const SQL_MIXPANEL_ACTIVITY = `
SELECT
  COUNT(*) FILTER (WHERE event = 'App/Site Opened') AS app_opens,
  COUNT(DISTINCT
    CASE WHEN event = '$ae_session'
      THEN DATE("time" AT TIME ZONE 'UTC') END
  ) AS distinct_session_days,
  COUNT(*) FILTER (WHERE event = 'Leads-Select-LeadStatusSheet') AS leads_marked,
  COUNT(*) FILTER (WHERE event IN (
    'Leads-Click-LeadContact',
    'Leads-Click-ChatCall',
    'Leads-Click-DetailCopyNumber'
  )) AS leads_contacted,
  COUNT(*) FILTER (WHERE event = 'Review-Click-SendInviteSingle') AS review_invites_sent,
  COUNT(*) FILTER (WHERE event IN (
    'Reviews-Click-ReviewReplyAI',
    'Reviews-Done-ReviewReply'
  )) AS review_replies,
  MAX("time") FILTER (WHERE event = 'App/Site Opened') AS last_app_open_at,
  MAX("time") AS last_event_at
FROM mixpanelzocaappdata.export
WHERE "locationEntityId" = {{entity_id}}
  AND "time" >= NOW() - ({{window_days}}::int * INTERVAL '1 day')
`;

type MixpanelRow = {
  app_opens: number | string | null;
  distinct_session_days: number | string | null;
  leads_marked: number | string | null;
  leads_contacted: number | string | null;
  review_invites_sent: number | string | null;
  review_replies: number | string | null;
  last_app_open_at: string | null;
  last_event_at: string | null;
} & Record<string, unknown>;

type EngagementTier = "active" | "light" | "cold" | "dormant";

interface MixpanelActivitySummary {
  entity_id: string;
  window_days: number;
  found: boolean;
  app_opens: number;
  distinct_session_days: number;
  leads_marked: number;
  leads_contacted: number;
  review_invites_sent: number;
  review_replies: number;
  last_app_open_at: string | null;
  last_event_at: string | null;
  engagement_tier: EngagementTier;
}

function toInt(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.floor(v) : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  }
  return 0;
}

function deriveTier(appOpens: number): EngagementTier {
  if (appOpens > 20) return "active";
  if (appOpens >= 5) return "light";
  if (appOpens >= 1) return "cold";
  return "dormant";
}

async function fetchMixpanelActivity(
  entityId: string,
  windowDays: number,
): Promise<MixpanelActivitySummary> {
  const rows = await runQuery<MixpanelRow>({
    database: DB.AURORA,
    sql: SQL_MIXPANEL_ACTIVITY,
    params: { entity_id: entityId, window_days: windowDays },
  });

  const row = rows[0];
  const appOpens = toInt(row?.app_opens);
  const sessionDays = toInt(row?.distinct_session_days);
  const leadsMarked = toInt(row?.leads_marked);
  const leadsContacted = toInt(row?.leads_contacted);
  const reviewInvites = toInt(row?.review_invites_sent);
  const reviewReplies = toInt(row?.review_replies);
  const lastOpen = row?.last_app_open_at ?? null;
  const lastEvent = row?.last_event_at ?? null;

  // "found" means we saw any event at all — not just app opens.
  const totalEvents =
    appOpens +
    sessionDays +
    leadsMarked +
    leadsContacted +
    reviewInvites +
    reviewReplies;

  return {
    entity_id: entityId,
    window_days: windowDays,
    found: totalEvents > 0 || lastEvent != null,
    app_opens: appOpens,
    distinct_session_days: sessionDays,
    leads_marked: leadsMarked,
    leads_contacted: leadsContacted,
    review_invites_sent: reviewInvites,
    review_replies: reviewReplies,
    last_app_open_at: lastOpen,
    last_event_at: lastEvent,
    engagement_tier: deriveTier(appOpens),
  };
}

export const getMixpanelActivityTool: BeaconTool = {
  name: "get_mixpanel_activity",
  description:
    "Live Zoca-app product-usage pull for ONE customer from Mixpanel (Aurora db=7 mixpanelzocaappdata.export) over a sliding window (default 30 days). Returns app opens, distinct session days, leads marked, leads contacted, review invites sent, last app open, and a derived engagement_tier (active/light/cold/dormant). Joined on properties.locationEntityId. Read-only, in-process 5-min cache. Soft-fails on Metabase outage.\n" +
    "Trigger phrases: \"are they using the app?\", \"how many app opens?\", \"are they marking leads?\", \"engagement tier?\", \"last time they opened Zoca?\", \"are they sending review invites?\".",
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

    const cacheKey = makeCacheKey("mixpanel-activity", {
      entity: entityId,
      window: windowDays,
    });

    try {
      const data = await getCachedContext(
        cacheKey,
        () => fetchMixpanelActivity(entityId, windowDays),
        { ttlMs: CACHE_TTL_MS },
      );

      const summary = data.found
        ? `Entity ${entityId.slice(0, 8)} (${windowDays}d): ${data.app_opens} app opens, ` +
          `${data.distinct_session_days} session days, ${data.leads_marked} leads marked, ` +
          `${data.leads_contacted} contact attempts — tier: ${data.engagement_tier}.`
        : `No Mixpanel activity for entity ${entityId.slice(0, 8)} in the last ${windowDays} days (tier: dormant).`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:get_mixpanel_activity",
        surface: "customer-360",
        entity_id: entityId,
        metadata: {
          tool: "get_mixpanel_activity",
          window_days: windowDays,
          app_opens: data.app_opens,
          engagement_tier: data.engagement_tier,
          leads_marked: data.leads_marked,
          leads_contacted: data.leads_contacted,
          review_invites: data.review_invites_sent,
        },
      });

      return { ok: true, summary, data: data as unknown as Record<string, unknown> };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: `Mixpanel activity fetch failed: ${msg.slice(0, 200)}`,
      };
    }
  },
};
