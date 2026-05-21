/**
 * Slack delivery — short summary + dashboard link, plus optional native file
 * upload of the .docx if SLACK_BOT_TOKEN is configured with files:write scope.
 */

const CHANNEL = process.env.SLACK_CHANNEL_ID ?? "C0B2ECQMDR9";
const TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

export type SlackPostResult = {
  posted: boolean;
  ts?: string;
  threadTs?: string;
  fileUrl?: string;
  reason?: string;
};

async function callSlack(method: string, body: unknown): Promise<any> {
  if (!TOKEN) throw new Error("SLACK_BOT_TOKEN not configured");
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`slack ${method}: ${data.error}`);
  return data;
}

function verdictPill(verdict: string | null, needsAmCall: boolean): string {
  const pill = verdict === "icp" ? "✅ ICP"
    : verdict === "review" ? "⚠️ Review"
    : verdict === "not_icp" ? "❌ Not ICP"
    : "⚪ Pending";
  return needsAmCall ? `${pill} · 🚨 Needs AM call` : pill;
}

export async function postCustomerReport(args: {
  cbCustomerId: string;
  bizName: string | null;
  amName: string | null;
  verdict: string | null;
  needsAmCall: boolean;
  oneLine: string | null;
  keyFlags: string[];
  markdown: string;
  docxBlobUrl: string | null;
}): Promise<SlackPostResult> {
  if (!TOKEN) {
    return { posted: false, reason: "SLACK_BOT_TOKEN not set" };
  }

  const dashboardUrl = APP_URL ? `${APP_URL}/reports/${args.cbCustomerId}` : null;

  const lines: string[] = [];
  lines.push(`*${verdictPill(args.verdict, args.needsAmCall)}* — ${args.bizName ?? args.cbCustomerId}`);
  lines.push(`• Customer ID: \`${args.cbCustomerId}\` · AM: ${args.amName ?? "—"}`);
  if (args.oneLine) lines.push(`• ${args.oneLine}`);
  if (args.keyFlags.length) {
    lines.push(`*Key flags*`);
    for (const f of args.keyFlags.slice(0, 5)) lines.push(`• ${f}`);
  }
  if (dashboardUrl) lines.push(`📊 <${dashboardUrl}|Open full report on dashboard>`);
  lines.push(`_Full analysis in thread ↓_`);

  const top = await callSlack("chat.postMessage", { channel: CHANNEL, text: lines.join("\n"), unfurl_links: false });
  const ts = top.ts as string;

  // Thread reply with the full Markdown analysis
  const threadRes = await callSlack("chat.postMessage", {
    channel: CHANNEL, thread_ts: ts, text: args.markdown.slice(0, 39000), unfurl_links: false,
  });

  // Optional: native file upload of the .docx
  let fileUrl: string | undefined;
  if (args.docxBlobUrl) {
    try {
      const blobRes = await fetch(args.docxBlobUrl);
      const buf = Buffer.from(await blobRes.arrayBuffer());
      const upload = await uploadDocxToSlack({
        buf, filename: `${args.cbCustomerId}-account-review.docx`, threadTs: ts,
      });
      fileUrl = upload.url;
    } catch (e: any) {
      console.error("[slack] docx upload failed:", e.message);
    }
  }

  return { posted: true, ts, threadTs: threadRes.ts, fileUrl };
}

/**
 * Upload a .docx to Slack using the files.upload v2 flow.
 * Returns the permalink URL of the uploaded file.
 */
async function uploadDocxToSlack(args: { buf: Buffer; filename: string; threadTs: string }) {
  // 1. Get an upload URL
  const init = await callSlack("files.getUploadURLExternal", {
    filename: args.filename, length: args.buf.length,
  });
  // 2. PUT the bytes to that URL. Wrap the Buffer in a Uint8Array so the fetch
  // BodyInit typing is satisfied (Buffer is a Node-only subclass).
  const put = await fetch(init.upload_url, {
    method: "POST",
    body: new Uint8Array(args.buf.buffer, args.buf.byteOffset, args.buf.byteLength),
  });
  if (!put.ok) throw new Error(`slack upload PUT ${put.status}`);
  // 3. Complete the upload, attaching to the channel/thread
  const done = await callSlack("files.completeUploadExternal", {
    files: [{ id: init.file_id, title: args.filename }],
    channel_id: CHANNEL,
    thread_ts: args.threadTs,
  });
  return { url: done.files?.[0]?.permalink };
}
