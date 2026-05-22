import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/customer/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Phase Beacon — Hourly AM-activity digest to Slack.
 *
 * Aggregates the last 1 hour of low/medium-signal AM events into a single
 * digest message and posts to SLACK_AM_ACTIVITY_WEBHOOK_URL.
 *
 * High-signal events (mark_contacted, note_saved, snooze_set, coaching_acted)
 * are posted real-time elsewhere — see lib/slack-am-activity.ts.
 *
 * Schedule: hourly (`0 * * * *`).
 * Auth: Bearer CRON_SECRET.
 */

const DIGEST_EVENTS: readonly string[] = [
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
];

const LABEL_MAP: Record<string, string> = {
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
};

function fmtCount(n: number, label: string): string {
  return `${n} ${label}`;
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

  // Pull last hour of digest events grouped by AM + event_name
  const rows = await sql`
    SELECT
      am_name,
      event_name,
      COUNT(*)::int AS cnt
    FROM am_activity_log
    WHERE ts > NOW() - INTERVAL '1 hour'
      AND am_name IS NOT NULL
      AND event_name = ANY(${DIGEST_EVENTS})
    GROUP BY am_name, event_name
    ORDER BY am_name ASC, event_name ASC
  `;

  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, posted: false, reason: "no activity in last hour" });
  }

  // Group into Map<am_name, Record<event_name, count>>
  const byAm: Map<string, Record<string, number>> = new Map();
  for (const r of rows as Array<{ am_name: string; event_name: string; cnt: number }>) {
    const e = byAm.get(r.am_name) || {};
    e[r.event_name] = r.cnt;
    byAm.set(r.am_name, e);
  }

  // Format message
  const lines: string[] = [":bar_chart: *Activity · last 1 hour*"];
  const sortedAms = Array.from(byAm.keys()).sort();
  for (const am of sortedAms) {
    const events = byAm.get(am) || {};
    const parts: string[] = [];
    // Order matters — most-meaningful first
    const ordered = [
      "customer_opened", "one_on_one_opened", "sign_in",
      "filter_changed", "sort_changed", "view_switched", "am_switched",
      "refresh_clicked", "coaching_dismissed", "page_view",
    ];
    for (const ev of ordered) {
      if (events[ev]) {
        parts.push(fmtCount(events[ev], LABEL_MAP[ev] || ev));
      }
    }
    if (parts.length > 0) {
      lines.push(`   • *${am}*: ${parts.join(" · ")}`);
    }
  }

  if (lines.length === 1) {
    return NextResponse.json({ ok: true, posted: false, reason: "no per-AM lines" });
  }

  const text = lines.join("\n");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch((e) => ({ ok: false, error: String(e) } as any));

  return NextResponse.json({
    ok: true,
    posted: !!(res as any).ok,
    ams: byAm.size,
  });
}
