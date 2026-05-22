/**
 * Slack webhook helper.
 *
 * Phase 9.8 introduced ad-hoc Slack posting inline in
 * `app/api/cron/health-alert/route.ts`. Phase 21 extracts that pattern into a
 * shared helper so the daily AM digest (lib/slack-digest.ts) can reuse it
 * without duplicating env handling, timeouts, and error swallowing.
 *
 * Both plain-text and Block Kit payloads are supported via the same
 * `postSlack()` entrypoint — pass `blocks` when you need rich formatting,
 * fall back to `text` (and a top-level `text` "fallback" string for
 * notification previews) otherwise.
 */

export type SlackBlock = Record<string, unknown>;

export type SlackPostInput = {
  /** Plain-text fallback / notification preview. Always include this for
   *  accessibility and notification previews, even when sending blocks. */
  text: string;
  /** Optional Block Kit blocks for rich layout. */
  blocks?: SlackBlock[];
};

export type SlackPostResult = {
  sent: boolean;
  status?: number;
  error?: string;
};

/**
 * Posts a message to `SLACK_WEBHOOK_URL` if it is configured. Returns
 * `{ sent: false }` (without throwing) when the env var is missing — callers
 * can decide whether that's an error or expected (e.g. local dev).
 */
export async function postSlack(input: SlackPostInput): Promise<SlackPostResult> {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    return { sent: false, error: "SLACK_WEBHOOK_URL not configured" };
  }
  const payload: Record<string, unknown> = { text: input.text };
  if (input.blocks && input.blocks.length > 0) {
    payload.blocks = input.blocks;
  }
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        sent: false,
        status: res.status,
        error: `slack webhook ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    return { sent: true, status: res.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { sent: false, error: msg };
  }
}

/** Whether SLACK_WEBHOOK_URL is configured (useful for dry-run / health). */
export function slackConfigured(): boolean {
  return !!process.env.SLACK_WEBHOOK_URL;
}
