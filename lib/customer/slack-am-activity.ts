/**
 * Phase Beacon — Slack AM activity stream.
 *
 * Posts a real-time message to the AM activity channel whenever an AM takes
 * a high-signal action (mark_contacted, note_saved, snooze_set, coaching_acted).
 * Lower-signal events flow into the hourly digest cron — see
 * app/api/cron/slack-activity-digest/route.ts.
 *
 * Fire-and-forget. Never blocks the caller. Slack failures are swallowed.
 */

import type { ActivityEvent, LogActivityInput } from "./activity";

const REALTIME_EVENTS: ReadonlySet<ActivityEvent> = new Set<ActivityEvent>([
  "mark_contacted",
  "note_saved",
  "snooze_set",
  "coaching_acted",
]);

const ACTION_LABEL: Partial<Record<ActivityEvent, string>> = {
  mark_contacted: "marked contacted",
  note_saved: "saved a note",
  snooze_set: "snoozed customer",
  coaching_acted: "acted on coaching loop",
};

const EMOJI: Partial<Record<ActivityEvent, string>> = {
  mark_contacted: ":white_check_mark:",
  note_saved: ":memo:",
  snooze_set: ":zzz:",
  coaching_acted: ":dart:",
};

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

// Phase 33.scope-slack — per-event message composer.
// Anchors line 1 on the bizname (or entity-id short hash fallback) and
// surfaces the actual edit content (note text / contact reason) as a Slack
// mrkdwn blockquote. Outcome / days / metric appear inline on line 1.
function buildText(input: LogActivityInput): string | null {
  if (!REALTIME_EVENTS.has(input.event_name)) return null;

  const am = input.am_name || input.email || "unknown";
  const emoji = EMOJI[input.event_name] || ":bell:";
  const m = input.metadata || {};

  // Target identifier: bizname (preferred) or entity_id short hash fallback.
  const bizname =
    typeof m.bizname === "string" && m.bizname.trim()
      ? m.bizname.trim()
      : null;
  const entityShort = input.entity_id ? input.entity_id.slice(0, 8) : null;
  const target = bizname
    ? `*${bizname}*`
    : entityShort
      ? `(${entityShort})`
      : "";

  switch (input.event_name) {
    case "note_saved": {
      const preview =
        typeof m.note_preview === "string" ? m.note_preview.trim() : "";
      const header = `${emoji} *${am}* saved a note${target ? ` for ${target}` : ""}`;
      // Slack mrkdwn blockquote — escape any leading `>` in the user's note
      // by prefixing each line with `> ` (handles multi-line notes too).
      const quoted = preview
        ? preview.split("\n").map((ln) => `> ${ln}`).join("\n")
        : "";
      return quoted ? `${header}\n${quoted}` : header;
    }
    case "mark_contacted": {
      const choice = typeof m.choice === "string" ? m.choice : null;
      const reason =
        typeof m.reason === "string" && m.reason.trim() ? m.reason.trim() : "";
      const outcome = choice ? ` — *${choice}*` : "";
      const header = `${emoji} *${am}* marked ${target} contacted${outcome}`;
      const quoted = reason
        ? reason.split("\n").map((ln) => `> ${ln}`).join("\n")
        : "";
      return quoted ? `${header}\n${quoted}` : header;
    }
    case "snooze_set": {
      const days =
        typeof m.days === "number" && Number.isFinite(m.days)
          ? `${m.days} days`
          : "";
      return `${emoji} *${am}* snoozed ${target}${days ? ` for *${days}*` : ""}`.trim();
    }
    case "coaching_acted": {
      const metric = typeof m.metric === "string" ? m.metric : "";
      // Coaching is AM-level — bizname is intentionally absent.
      const header = `${emoji} *${am}* acted on coaching loop`;
      return metric ? `${header}\n   Metric: \`${metric}\`` : header;
    }
    default:
      return null;
  }
}

/**
 * Post a real-time message about an AM action to Slack. Never throws.
 * Called fire-and-forget from logActivity after the Postgres INSERT.
 */
export async function postRealtimeAmActivity(input: LogActivityInput): Promise<void> {
  try {
    if (!REALTIME_EVENTS.has(input.event_name)) return;
    const url = process.env.SLACK_AM_ACTIVITY_WEBHOOK_URL;
    if (!url) return;
    const text = buildText(input);
    if (!text) return;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => {});
  } catch {
    // Never break the activity logger. Silent failure.
  }
}

export { REALTIME_EVENTS };
export { fmtMoney };
