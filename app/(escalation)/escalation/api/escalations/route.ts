// GET /api/escalations
//
// Two modes:
//   ?q=<biz | entity | email | cb_id>                 -> resolve customer + return all 5 channels (best-effort, partial OK)
//   ?q=<...> &channel=app_chat|email|phone|video|sms  -> fetch ONLY that channel (faster, used by the UI's progressive loader)
//
// Other params:
//   sinceDays      default 365  (0 or negative = no time filter)
//   perChannelLimit default 200
//   timeoutMs       default 25000 ms per channel (single-channel mode raises this)
//
// Behaviour: stream-parses Metabase CSVs and exits early once `perChannelLimit`
// matches are found. Channels that hit the timeout are reported in
// `perChannelStatus.<channel>.aborted = true` rather than failing the whole
// request — partial results are useful while we wait for the slow ones.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  fetchChannelForEntity,
  fetchCommsForEntity,
  searchBaseSheet,
  type BaseSheetRow,
} from "@/lib/escalation/metabase";
import { fetchTicketsForCustomer, type MetabaseTicket } from "@/lib/escalation/tickets";
import type { Channel, CommsMessage } from "@/lib/escalation/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  return session ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

interface CustomerCard {
  bizName: string;
  entityId: string;
  customerId: string;
  email: string;
  phone: string;
  amName: string;
  spName: string;
  aeName: string;
  status: string;
  churnDate: string;
  monthlyRevenue?: number;
}

function toCard(row: BaseSheetRow): CustomerCard {
  const mrrNum = Number((row.total_monthly_revenue || "").replace(/[^0-9.\-]/g, ""));
  return {
    bizName: row.bizname,
    entityId: row.entity_id,
    customerId: row.customer_id,
    email: row.app_email || row.gbp_email || row.dct_email,
    phone: row.phone_number,
    amName: row.am_name,
    spName: row.sp_name,
    aeName: row.ae_name,
    status: row.chrone_zoca_status,
    churnDate: row.churn_date,
    monthlyRevenue: Number.isFinite(mrrNum) ? mrrNum : undefined,
  };
}

const CHANNELS: Channel[] = ["app_chat", "email", "phone", "video", "sms"];

function statsOf(comms: CommsMessage[]) {
  const byChannel: Record<string, number> = {};
  const bySender: Record<string, number> = {};
  for (const m of comms) {
    byChannel[m.channel] = (byChannel[m.channel] || 0) + 1;
    bySender[m.sender] = (bySender[m.sender] || 0) + 1;
  }
  return { total: comms.length, byChannel, bySender };
}

export async function GET(req: NextRequest) {
  const authFail = await requireAuth();
  if (authFail) return authFail;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const channelParam = (url.searchParams.get("channel") || "").trim().toLowerCase();
  const skipComms = url.searchParams.get("skipComms") === "1";
  const sinceDays = Number(url.searchParams.get("sinceDays") ?? "365");
  const perChannelLimit = Number(url.searchParams.get("perChannelLimit") ?? "200");
  const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? "");

  if (!q) {
    return NextResponse.json(
      { ok: false, error: "Missing query. Pass ?q=<biz | entity | email | cb_id>" },
      { status: 400 }
    );
  }

  try {
    const matches = await searchBaseSheet(q, 10);
    if (!matches.length) {
      return NextResponse.json({
        ok: true,
        query: q,
        matches: [],
        customer: null,
        comms: [],
        stats: { total: 0, byChannel: {}, bySender: {} },
        perChannelStatus: {},
        lookupNotes: ["No customer matched that search. Try a UUID, exact biz name, or an email address."],
      });
    }

    const primary = matches[0];
    if (!primary.entity_id) {
      return NextResponse.json({
        ok: true,
        query: q,
        matches: matches.map(toCard),
        customer: toCard(primary),
        comms: [],
        stats: { total: 0, byChannel: {}, bySender: {} },
        perChannelStatus: {},
        lookupNotes: ["BaseSheet row found but no entity_id, so we can't pull comms history."],
      });
    }

    // SINGLE-CHANNEL mode (used by the UI for progressive loading).
    if (channelParam && CHANNELS.includes(channelParam as Channel)) {
      const ch = channelParam as Channel;
      const r = await fetchChannelForEntity(primary.entity_id, ch, {
        sinceDays,
        perChannelLimit,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 50000,
      });
      return NextResponse.json({
        ok: true,
        query: q,
        matches: matches.map(toCard),
        customer: toCard(primary),
        channel: ch,
        comms: r.messages,
        stats: statsOf(r.messages),
        perChannelStatus: { [ch]: { fetched: r.messages.length, aborted: r.aborted, error: r.error } },
        lookupNotes:
          matches.length > 1
            ? [`${matches.length} BaseSheet rows matched "${q}". Showing the first.`]
            : [],
      });
    }

    // FAST PATH — customer + tickets only. No comms fetch. Used by phase 1
    // of the UI so the page can render immediately.
    if (skipComms) {
      const ticketsRes = await fetchTicketsForCustomer({
        entityId: primary.entity_id,
        customerId: primary.customer_id,
        bizName: primary.bizname,
        sinceDays: 0,
        limit: 50,
      }).catch((): MetabaseTicket[] => []);

      return NextResponse.json({
        ok: true,
        query: q,
        matches: matches.map(toCard),
        customer: toCard(primary),
        comms: [],
        stats: { total: 0, byChannel: {}, bySender: {} },
        perChannelStatus: {},
        tickets: ticketsRes,
        skippedComms: true,
        lookupNotes:
          matches.length > 1
            ? [`${matches.length} BaseSheet rows matched "${q}". Showing the first.`]
            : [],
      });
    }

    // MULTI-CHANNEL mode (default).
    // Run comms fetch (slow, big CSVs) and ticket fetch (fast, smaller CSV)
    // in parallel — we stitch them together at the end.
    const [result, ticketsRes] = await Promise.all([
      fetchCommsForEntity(primary.entity_id, {
        sinceDays,
        perChannelLimit,
        perChannelTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 25000,
      }),
      fetchTicketsForCustomer({
        entityId: primary.entity_id,
        customerId: primary.customer_id,
        bizName: primary.bizname,
        sinceDays: 0,
        limit: 50,
      }).catch((): MetabaseTicket[] => {
        // Tickets failure shouldn't fail the whole lookup.
        return [];
      }),
    ]);

    const lookupNotes: string[] = [];
    if (matches.length > 1) {
      lookupNotes.push(`${matches.length} BaseSheet rows matched "${q}". Showing the first; others under matches.`);
    }
    const aborted = (Object.entries(result.perChannelStatus) as [Channel, { aborted: boolean }][])
      .filter(([, s]) => s.aborted)
      .map(([ch]) => ch);
    if (aborted.length) {
      lookupNotes.push(
        `Timed out fetching: ${aborted.join(", ")}. They'll be quick on the next try (cached at the edge for 24h). You can also load each channel individually using ?channel=<name>.`
      );
    }

    return NextResponse.json({
      ok: true,
      query: q,
      matches: matches.map(toCard),
      customer: toCard(primary),
      comms: result.messages,
      stats: statsOf(result.messages),
      perChannelStatus: result.perChannelStatus,
      tickets: ticketsRes,
      lookupNotes,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Internal error" },
      { status: 500 }
    );
  }
}
