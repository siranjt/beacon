/**
 * Phase E-17 Wave 3b — Slack DM helper for proactive Beam.
 *
 * The existing `lib/customer/slack.ts` posts via an INCOMING WEBHOOK URL,
 * which is bound to a single channel (the digest channel). That's fine for
 * the broadcast-style daily-digest cron, but the proactive Monday briefing
 * + daily anomaly digest crons need to DM each AM individually.
 *
 * Slack Web API `chat.postMessage` accepts a user id (e.g. "U12345678") in
 * the `channel` field and Slack opens/reuses the IM automatically — no
 * conversations.open call required. We use a bot token (SLACK_BOT_TOKEN)
 * with `chat:write` + `im:write` scopes.
 *
 * Soft-fails when:
 *   - SLACK_BOT_TOKEN is unset → caller sees `{ ok: false, error }` and
 *     logs the skip + continues. We do NOT crash the cron.
 *   - Slack returns ok:false (e.g. user not in workspace) → same.
 *
 * Never throws. Caller is responsible for pacing (1/sec) — this helper has
 * no built-in rate limiter.
 */

export type SlackDmInput = {
  /** Plain text fallback / notification preview. Required by Slack for
   *  accessibility + push notification previews. */
  text: string;
};

export type SlackDmResult = {
  ok: boolean;
  status?: number;
  error?: string;
  /** Slack response on success — useful for debugging in cron logs. */
  ts?: string;
  channel?: string;
};

const SLACK_API = "https://slack.com/api/chat.postMessage";

/**
 * Post a DM to a single Slack user. Returns soft-fail result; never throws.
 * `slackUserId` is the workspace user id (starts with "U" or "W").
 */
export async function postSlackDm(
  slackUserId: string,
  payload: SlackDmInput,
): Promise<SlackDmResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return { ok: false, error: "SLACK_BOT_TOKEN not configured" };
  }
  if (!slackUserId || typeof slackUserId !== "string") {
    return { ok: false, error: "slackUserId must be a non-empty string" };
  }
  if (!payload.text || typeof payload.text !== "string") {
    return { ok: false, error: "payload.text must be a non-empty string" };
  }

  try {
    const res = await fetch(SLACK_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: slackUserId,
        text: payload.text,
        // Slack's "unfurl" defaults are off for bot DMs — fine for us.
        unfurl_links: false,
        unfurl_media: false,
        // mrkdwn is the default; explicit for clarity.
        mrkdwn: true,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error: `slack ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    // Slack returns HTTP 200 even on logical errors. Check json.ok.
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; error?: string; channel?: string; ts?: string }
      | null;
    if (!json) {
      return { ok: false, status: res.status, error: "non-json slack response" };
    }
    if (!json.ok) {
      return {
        ok: false,
        status: res.status,
        error: `slack api: ${json.error || "unknown"}`,
      };
    }
    return { ok: true, status: res.status, ts: json.ts, channel: json.channel };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/** Whether SLACK_BOT_TOKEN is configured (useful for diagnostics / dry-run). */
export function slackDmConfigured(): boolean {
  return !!process.env.SLACK_BOT_TOKEN;
}
