import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/customer/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Hourly umbrella-wide activity digest to Slack. Phase E-8.
 *
 * Aggregates the last 1 hour of dashboard activity across ALL four agents
 * (customer, performance, escalation, post-payment) plus the umbrella
 * launcher and posts to SLACK_AM_ACTIVITY_WEBHOOK_URL. Each agent gets its
 * own section in the message.
 *
 * High-signal Customer Beacon events (mark_contacted, note_saved,
 * snooze_set, coaching_acted) post in real time via
 * lib/customer/slack-am-activity.ts and are excluded from the digest to
 * avoid double-posting.
 *
 * Customer Beacon rows group by am_name. Other agents group by email since
 * there's no AM concept. The message uses "First Last (email-user@zoca.com)"
 * format for non-Customer rows so it's readable in Slack.
 *
 * Schedule: hourly (`0 * * * *`).
 * Auth: Bearer CRON_SECRET.
 */

const DIGEST_EVENTS: readonly string[] = [
  // Customer Beacon (low/medium signal — high-signal Customer events skip the digest)
  "customer_opened",
  "page_view",
  "filter_changed",
  "sort_changed",
  "refresh_clicked",
  "view_switched",
  "am_switched",
  "one_on_one_opened",
  "sign_in",
  "coaching_dismissed",
  // Performance
  "report_generated",
  "report_opened",
  "recent_report_clicked",
  "customer_searched",
  "preview_closed",
  // Escalation
  "search_submitted",
  "tab_switched",
  "ticket_opened",
  "queue_filter_changed",
  // Post-payment
  "verdict_filter_changed",
  "rerun_clicked",
  "docx_opened",
  "rerender_clicked",
  // Umbrella
  "launcher_card_clicked",
  "sign_out",
];

const LABEL_MAP: Record<string, string> = {
  // Customer
  customer_opened: "customers opened",
  page_view: "pages viewed",
  filter_changed: "filters changed",
  sort_changed: "sort changed",
  refresh_clicked: "refresh",
  view_switched: "view switched",
  am_switched: "AM switched",
  one_on_one_opened: "1:1 opened",
  sign_in: "sign-in",
  coaching_dismissed: "coaching dismissed",
  // Performance
  report_generated: "reports generated",
  report_opened: "reports opened",
  recent_report_clicked: "recent reports opened",
  customer_searched: "customer searches",
  preview_closed: "previews closed",
  // Escalation
  search_submitted: "searches",
  tab_switched: "tab switches",
  ticket_opened: "tickets opened",
  queue_filter_changed: "queue filters",
  // Post-payment
  verdict_filter_changed: "verdict filters",
  rerun_clicked: "re-runs",
  docx_opened: "docx opened",
  rerender_clicked: "re-renders",
  // Umbrella
  launcher_card_clicked: "launcher clicks",
  sign_out: "sign-outs",
};

// Display order for each agent section. Events not in the list still appear,
// but in this preferred sequence first.
const EVENT_ORDER_PER_AGENT: Record<string, string[]> = {
  customer: [
    "customer_opened", "one_on_one_opened", "sign_in",
    "filter_changed", "sort_changed", "view_switched", "am_switched",
    "refresh_clicked", "coaching_dismissed", "page_view",
  ],
  performance: [
    "customer_searched", "report_generated", "report_opened",
    "recent_report_clicked", "preview_closed", "page_view",
  ],
  escalation: [
    "search_submitted", "ticket_opened", "tab_switched",
    "queue_filter_changed", "page_view",
  ],
  "post-payment": [
    "rerun_clicked", "rerender_clicked", "docx_opened",
    "verdict_filter_changed", "page_view",
  ],
  umbrella: [
    "launcher_card_clicked", "sign_out",
  ],
};

const AGENT_ORDER: string[] = [
  "customer",
  "performance",
  "escalation",
  "post-payment",
  "umbrella",
];

const AGENT_LABEL: Record<string, string> = {
  customer: ":bulb: Customer Beacon",
  performance: ":bar_chart: Performance Beacon",
  escalation: ":rotating_light: Escalation Beacon",
  "post-payment": ":receipt: Post-Payment Reviews",
  umbrella: ":beacon: Umbrella / launcher",
};

function fmtCount(n: number, label: string): string {
  return `${n} ${label}`;
}

// Pretty user label: Customer Beacon rows use am_name when set; everyone
// else falls back to the email's local-part (camel-cased) + email in parens.
function userLabel(agent: string, am_name: string | null, email: string): string {
  if (agent === "customer" && am_name) return am_name;
  const local = (email.split("@")[0] || email).replace(/[._-]+/g, " ");
  return local || email;
}

export async function GET(req: NextRequest) {
  // Auth — bearer CRON_SECRET
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const got = req.headers.get("authorization") || "";
  if (got !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const webhookUrl = process.env.SLACK_AM_ACTIVITY_WEBHOOK_URL;
  if (!webhookUrl) {
    return NextResponse.json({ ok: false, error: "SLACK_AM_ACTIVITY_WEBHOOK_URL not set" });
  }

  const sql = getSql();
  if (!sql) {
    return NextResponse.json({ ok: false, error: "no db connection" });
  }

  // Pull last hour of digest events grouped by (agent, user, event_name).
  // Customer Beacon rows have am_name populated and we group by that.
  // Other agents group by email (am_name is null for them).
  const rows = await sql`
    SELECT
      agent,
      am_name,
      email,
      event_name,
      COUNT(*)::int AS cnt
    FROM am_activity_log
    WHERE ts > NOW() - INTERVAL '1 hour'
      AND event_name = ANY(${DIGEST_EVENTS})
    GROUP BY agent, am_name, email, event_name
    ORDER BY agent ASC, am_name ASC NULLS LAST, email ASC, event_name ASC
  `;

  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, posted: false, reason: "no activity in last hour" });
  }

  // Group into Map<agent, Map<userLabel, Record<event_name, count>>>
  type EventCounts = Record<string, number>;
  type UserMap = Map<string, EventCounts>;
  const byAgent: Map<string, UserMap> = new Map();

  for (const r of rows as Array<{
    agent: string;
    am_name: string | null;
    email: string;
    event_name: string;
    cnt: number;
  }>) {
    const agent = r.agent || "customer";
    const user = userLabel(agent, r.am_name, r.email);
    let userMap = byAgent.get(agent);
    if (!userMap) {
      userMap = new Map();
      byAgent.set(agent, userMap);
    }
    let events = userMap.get(user);
    if (!events) {
      events = {};
      userMap.set(user, events);
    }
    events[r.event_name] = r.cnt;
  }

  // Format message
  const lines: string[] = [":bar_chart: *Beacon activity · last 1 hour*"];

  for (const agent of AGENT_ORDER) {
    const userMap = byAgent.get(agent);
    if (!userMap || userMap.size === 0) continue;

    lines.push("");
    lines.push(AGENT_LABEL[agent] || `*${agent}*`);

    const sortedUsers = Array.from(userMap.keys()).sort();
    const order = EVENT_ORDER_PER_AGENT[agent] || [];

    for (const user of sortedUsers) {
      const events = userMap.get(user) || {};
      const parts: string[] = [];
      // Ordered events first
      for (const ev of order) {
        if (events[ev]) {
          parts.push(fmtCount(events[ev], LABEL_MAP[ev] || ev));
        }
      }
      // Any leftover events (newly added, not yet in EVENT_ORDER_PER_AGENT)
      for (const ev of Object.keys(events)) {
        if (order.includes(ev)) continue;
        parts.push(fmtCount(events[ev], LABEL_MAP[ev] || ev));
      }
      if (parts.length > 0) {
        lines.push(`   • *${user}*: ${parts.join(" · ")}`);
      }
    }
  }

  // If nothing landed in any agent section, skip the post.
  if (lines.length <= 1) {
    return NextResponse.json({ ok: true, posted: false, reason: "no per-agent rows" });
  }

  const text = lines.join("\n");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch((e) => ({ ok: false, error: String(e) } as { ok: boolean; error?: string }));

  return NextResponse.json({
    ok: true,
    posted: !!("ok" in res ? res.ok : false),
    agents: byAgent.size,
    rows: rows.length,
  });
}
