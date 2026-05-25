import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/customer/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Hourly umbrella-wide activity digest to Slack. Phase E-8 (v2 — detailed).
 *
 * Posts a per-agent, per-user chronological timeline of the last hour's
 * activity across all four agents + the umbrella launcher. Each user
 * section reads as a narrative ("8:35 PM — opened Performance landing,
 * 8:36 PM — searched a24bbd56…, 8:36 PM — opened recent report ×4") instead
 * of just a rollup count.
 *
 * High-signal Customer Beacon events (mark_contacted, note_saved,
 * snooze_set, coaching_acted) STILL fire real-time via
 * lib/customer/slack-am-activity.ts. They're ALSO included in this digest
 * so the chronological narrative is complete — the duplication is
 * intentional (real-time = "this is happening NOW", digest = "here's the
 * hour in context").
 *
 * Slack message structure:
 *   :bar_chart: *Beacon activity · last 1 hour*
 *
 *   :bulb: *Customer Beacon*
 *      *Sudha Goutami* (sudha.g@zoca.com) — 7 actions
 *        • 8:32 PM — signed in
 *        • 8:33 PM — viewed AM dashboard
 *        • 8:34 PM — opened SkinSpa NYC (entity 4f31a2c1…)
 *        • 8:35 PM — filtered to CRITICAL tier
 *        • 8:36 PM — marked SkinSpa NYC contacted
 *        ...
 *
 *   :bar_chart: *Performance Beacon*
 *      *Siranjith T* (siranjith.t@zoca.com) — 4 actions
 *        • 8:37 PM — viewed Performance landing
 *        • 8:37 PM — searched a24bbd56…
 *        • 8:38 PM — opened recent report (×4)
 *
 * Caps:
 *   - 25 events per (agent, user). Excess shown as "(+N more)".
 *   - Consecutive identical events (same event+entity within 60s) collapse
 *     to "(×N)".
 *
 * Schedule: hourly (`0 * * * *`).
 * Auth: Bearer CRON_SECRET.
 */

const DIGEST_EVENTS: readonly string[] = [
  // Customer Beacon
  "sign_in",
  "page_view",
  "refresh_clicked",
  "filter_changed",
  "sort_changed",
  "am_switched",
  "view_switched",
  "customer_opened",
  "one_on_one_opened",
  "coaching_dismissed",
  "mark_contacted",
  "note_saved",
  "snooze_set",
  "coaching_acted",
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
  "command_palette_opened",
  "command_palette_select",
  "claude_asked",
];

// Human label for each surface. Keep short; appears inline in a narrative.
const SURFACE_LABEL: Record<string, string> = {
  // Customer Beacon
  v2_dashboard: "AM dashboard",
  v2_customer_detail: "customer detail",
  v2_manager_1on1: "1:1 prep",
  v2_coaching: "coaching loops",
  v2_timeline: "timeline",
  admin_usage: "admin · usage",
  // Performance
  performance_landing: "Performance landing",
  performance_report: "Performance report",
  // Escalation
  escalation_home: "Escalation home",
  escalation_queue: "Escalation queue",
  escalation_triage: "Escalation triage",
  escalation_tickets: "Escalation tickets",
  escalation_customer: "Escalation customer 360",
  // Post-Payment
  post_payment_dashboard: "Post-Payment dashboard",
  post_payment_report: "Post-Payment report",
  // Umbrella
  launcher: "launcher",
  auth: "sign-in screen",
};

const AGENT_ORDER: string[] = [
  "customer",
  "performance",
  "escalation",
  "post-payment",
  "umbrella",
];

const AGENT_LABEL: Record<string, string> = {
  customer: ":bulb: *Customer Beacon*",
  performance: ":bar_chart: *Performance Beacon*",
  escalation: ":rotating_light: *Escalation Beacon*",
  "post-payment": ":receipt: *Post-Payment Reviews*",
  umbrella: ":beacon: *Umbrella · launcher*",
};

const PER_USER_EVENT_CAP = 25;
// Two consecutive events are collapsed to "(×N)" if same event+entity AND
// ts gap is below this threshold (ms).
const COLLAPSE_WINDOW_MS = 60_000;

interface ActivityRow {
  agent: string;
  am_name: string | null;
  email: string;
  event_name: string;
  surface: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  ts: string; // ISO from neon driver
}

function shortEntity(id: string | null | undefined): string {
  if (!id) return "";
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function bizFromMeta(m: Record<string, unknown> | null | undefined): string | null {
  if (!m) return null;
  const candidates = ["bizname", "biz_name", "business_name", "customer_name"];
  for (const k of candidates) {
    const v = m[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function metaString(m: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!m) return null;
  const v = m[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Compose a human-readable action description from an event row.
 * Keeps each description short (one short clause) so the bullet stays on
 * one line in Slack.
 */
function describeAction(r: ActivityRow): string {
  const biz = bizFromMeta(r.metadata);
  const ent = shortEntity(r.entity_id);
  const sfc = r.surface ? SURFACE_LABEL[r.surface] || r.surface : null;

  switch (r.event_name) {
    // Customer Beacon
    case "sign_in":
      return "signed in";
    case "sign_out":
      return "signed out";
    case "page_view":
      return sfc ? `viewed ${sfc}` : "viewed a page";
    case "refresh_clicked":
      return "refreshed snapshot";
    case "filter_changed": {
      const filt =
        metaString(r.metadata, "filter") ||
        metaString(r.metadata, "tier") ||
        metaString(r.metadata, "signal") ||
        metaString(r.metadata, "pod");
      return filt ? `changed filter to *${filt}*` : "changed a filter";
    }
    case "sort_changed":
      return `changed sort${metaString(r.metadata, "sort") ? ` to *${metaString(r.metadata, "sort")}*` : ""}`;
    case "am_switched":
      return `switched AM to *${metaString(r.metadata, "am") || metaString(r.metadata, "to") || "another"}*`;
    case "view_switched":
      return `switched view to *${metaString(r.metadata, "view") || metaString(r.metadata, "to") || "another"}*`;
    case "customer_opened":
      return biz
        ? `opened *${biz}*${ent ? ` (${ent})` : ""}`
        : ent
        ? `opened customer ${ent}`
        : "opened a customer";
    case "one_on_one_opened":
      return `opened 1:1 prep${metaString(r.metadata, "am") ? ` for *${metaString(r.metadata, "am")}*` : ""}`;
    case "coaching_dismissed":
      return biz ? `dismissed coaching for *${biz}*` : "dismissed coaching";
    case "mark_contacted":
      return biz ? `marked *${biz}* as contacted` : ent ? `marked ${ent} contacted` : "marked a customer contacted";
    case "note_saved":
      return biz ? `saved note on *${biz}*` : "saved a note";
    case "snooze_set":
      return biz ? `snoozed *${biz}*` : "snoozed a customer";
    case "coaching_acted":
      return biz ? `acted on coaching for *${biz}*` : "acted on coaching";

    // Performance Beacon
    case "report_generated":
      return ent ? `generated report for ${ent}` : "generated a report";
    case "report_opened":
      return ent ? `opened report for ${ent}` : "opened a report";
    case "recent_report_clicked":
      return ent ? `opened recent report ${ent}` : "opened a recent report";
    case "customer_searched":
      return ent ? `searched for ${ent}` : "ran a customer search";
    case "preview_closed":
      return "closed the preview";

    // Escalation Beacon
    case "search_submitted":
      return `submitted search${metaString(r.metadata, "query") ? ` for "${metaString(r.metadata, "query")?.slice(0, 40)}"` : ""}`;
    case "tab_switched":
      return `switched tab${metaString(r.metadata, "tab") ? ` to *${metaString(r.metadata, "tab")}*` : ""}`;
    case "ticket_opened": {
      const tid = metaString(r.metadata, "ticket_id") || metaString(r.metadata, "ticket");
      return tid ? `opened ticket *${tid}*` : ent ? `opened ticket on ${ent}` : "opened a ticket";
    }
    case "queue_filter_changed":
      return "changed queue filter";

    // Post-Payment
    case "verdict_filter_changed":
      return `filtered verdict${metaString(r.metadata, "verdict") ? ` = *${metaString(r.metadata, "verdict")}*` : ""}`;
    case "rerun_clicked":
      return biz ? `re-ran analysis for *${biz}*` : ent ? `re-ran analysis for ${ent}` : "re-ran an analysis";
    case "docx_opened":
      return biz ? `opened docx for *${biz}*` : ent ? `opened docx for ${ent}` : "opened a docx";
    case "rerender_clicked":
      return biz ? `re-rendered docx for *${biz}*` : ent ? `re-rendered docx for ${ent}` : "re-rendered a docx";

    // Umbrella
    case "launcher_card_clicked": {
      const agentName = metaString(r.metadata, "agent_name");
      return agentName ? `opened *${agentName}*` : "clicked a launcher card";
    }
    case "command_palette_opened":
      return "opened the command palette";
    case "command_palette_select": {
      const agent = metaString(r.metadata, "agent");
      if (biz) return `jumped to *${biz}* via Cmd+K${agent ? ` (${agent})` : ""}`;
      if (ent) return `jumped to ${ent} via Cmd+K${agent ? ` (${agent})` : ""}`;
      return "selected a result from Cmd+K";
    }
    case "claude_asked": {
      // Internal event_name stays as claude_asked (no schema migration) but
      // user-facing copy in Slack says "Beacon" — the brand.
      const bizMeta = metaString(r.metadata, "biz_name");
      const audience = metaString(r.metadata, "audience");
      if (audience) return `asked Beacon about *${audience}*`;
      if (bizMeta) return `asked Beacon about *${bizMeta}*`;
      return "asked Beacon for help";
    }

    default:
      return r.event_name.replace(/_/g, " ");
  }
}

/**
 * Slack-renderable time. Uses Slack's <!date^...> syntax so each viewer
 * sees the timestamp in their own timezone. Falls back to UTC if Slack
 * can't render (e.g. in email digest mode).
 */
function fmtSlackTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const epoch = Math.floor(t / 1000);
  // {time} = 7:35 PM (per viewer's TZ + 12/24 settings)
  // Fallback = UTC HH:mm so it stays useful in logs / non-Slack consumers
  const utc = new Date(t).toISOString().slice(11, 16) + " UTC";
  return `<!date^${epoch}^{time}|${utc}>`;
}

/** Two events collapse if same event+entity AND within COLLAPSE_WINDOW_MS. */
function shouldCollapse(a: ActivityRow, b: ActivityRow): boolean {
  if (a.event_name !== b.event_name) return false;
  if ((a.entity_id || "") !== (b.entity_id || "")) return false;
  const at = Date.parse(a.ts);
  const bt = Date.parse(b.ts);
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return false;
  return Math.abs(bt - at) <= COLLAPSE_WINDOW_MS;
}

interface CompressedEvent {
  representative: ActivityRow;
  count: number;
}

function compressEvents(events: ActivityRow[]): CompressedEvent[] {
  if (events.length === 0) return [];
  const out: CompressedEvent[] = [];
  let cur: CompressedEvent = { representative: events[0], count: 1 };
  for (let i = 1; i < events.length; i++) {
    if (shouldCollapse(cur.representative, events[i])) {
      cur.count += 1;
    } else {
      out.push(cur);
      cur = { representative: events[i], count: 1 };
    }
  }
  out.push(cur);
  return out;
}

function userLabel(agent: string, am_name: string | null, email: string): string {
  if (agent === "customer" && am_name) return am_name;
  // Pretty-print local-part: "siranjith.t" → "Siranjith T"
  const local = (email.split("@")[0] || email).replace(/[._-]+/g, " ");
  return local
    .split(" ")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
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

  // Pull individual events ordered chronologically per (agent, user).
  // 5000-row safety cap protects against a runaway hour; in practice an
  // hour-window from a few-user dashboard will be well under that.
  const rows = (await sql`
    SELECT
      agent,
      am_name,
      email,
      event_name,
      surface,
      entity_id,
      metadata,
      ts::text AS ts
    FROM am_activity_log
    WHERE ts > NOW() - INTERVAL '1 hour'
      AND event_name = ANY(${DIGEST_EVENTS})
    ORDER BY agent ASC, COALESCE(am_name, email) ASC, ts ASC
    LIMIT 5000
  `) as unknown as ActivityRow[];

  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, posted: false, reason: "no activity in last hour" });
  }

  // Group: Map<agent, Map<userKey, { label: string, events: ActivityRow[] }>>
  type UserBucket = { label: string; events: ActivityRow[] };
  type AgentBucket = Map<string, UserBucket>;
  const byAgent: Map<string, AgentBucket> = new Map();

  for (const r of rows) {
    const agent = r.agent || "customer";
    const userKey = `${r.am_name ?? ""}|${r.email}`;
    let agentBucket = byAgent.get(agent);
    if (!agentBucket) {
      agentBucket = new Map();
      byAgent.set(agent, agentBucket);
    }
    let userBucket = agentBucket.get(userKey);
    if (!userBucket) {
      userBucket = {
        label: userLabel(agent, r.am_name, r.email),
        events: [],
      };
      agentBucket.set(userKey, userBucket);
    }
    userBucket.events.push(r);
  }

  // Format message
  const lines: string[] = [":bar_chart: *Beacon activity · last 1 hour*"];

  for (const agent of AGENT_ORDER) {
    const agentBucket = byAgent.get(agent);
    if (!agentBucket || agentBucket.size === 0) continue;

    lines.push("");
    lines.push(AGENT_LABEL[agent] || `*${agent}*`);

    // Sort users by label for stable output
    const sortedUsers = Array.from(agentBucket.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );

    for (const user of sortedUsers) {
      const compressed = compressEvents(user.events);
      const totalActions = user.events.length;

      // Header line per user
      const emailRow = user.events[0];
      const email = emailRow?.email ?? "";
      lines.push(
        `   *${user.label}* (${email}) — ${totalActions} action${totalActions === 1 ? "" : "s"}`,
      );

      // Show up to PER_USER_EVENT_CAP groups; tally the rest as "+ N more"
      const visible = compressed.slice(0, PER_USER_EVENT_CAP);
      const hiddenGroups = compressed.slice(PER_USER_EVENT_CAP);
      const hiddenActionCount = hiddenGroups.reduce((sum, g) => sum + g.count, 0);

      for (const grp of visible) {
        const time = fmtSlackTime(grp.representative.ts);
        const desc = describeAction(grp.representative);
        const suffix = grp.count > 1 ? ` _(×${grp.count})_` : "";
        lines.push(`      • ${time} — ${desc}${suffix}`);
      }
      if (hiddenActionCount > 0) {
        lines.push(`      • _… and ${hiddenActionCount} more action${hiddenActionCount === 1 ? "" : "s"}_`);
      }
    }
  }

  if (lines.length <= 1) {
    return NextResponse.json({ ok: true, posted: false, reason: "no per-agent rows" });
  }

  const text = lines.join("\n");

  // Slack accepts ~40k chars per message; we cap each user at 25 events so
  // realistically the message stays well under that. If we ever blow it,
  // Slack will truncate gracefully — but that'd be a sign to lower the cap.
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch((e) => ({ ok: false, error: String(e) } as { ok: boolean; error?: string }));

  return NextResponse.json({
    ok: true,
    posted: !!("ok" in res ? res.ok : false),
    agents: byAgent.size,
    users: Array.from(byAgent.values()).reduce((sum, m) => sum + m.size, 0),
    events: rows.length,
    message_chars: text.length,
  });
}
