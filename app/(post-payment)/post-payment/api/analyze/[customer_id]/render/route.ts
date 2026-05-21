/**
 * Stage 3b of the analyze pipeline — docx render + Slack post.
 *
 * Loads the eval (markdown + reportData) saved by Stage 3a, renders the
 * Word doc, uploads to Vercel Blob, updates DB with the blob URLs, and
 * posts to Slack.
 *
 * Split out from Stage 3a so the slow LLM call (60–120s) and the fast
 * render + Slack (~10s) each fit comfortably under Vercel's function cap.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { renderAndUpload } from "@/lib/post-payment/render/render";
import { postCustomerReport } from "@/lib/post-payment/slack";
import { fetchJson, fetchText } from "@/lib/post-payment/stage-store";
import { setCustomerReport, setCustomerStatus, logEvent, getCustomer } from "@/lib/post-payment/db/queries";

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  return session ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export const runtime = "nodejs";
// docx render + Slack upload should comfortably fit in <30s. Cap at 120s
// for safety (Slack file upload over a slow network can drag).
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: { customer_id: string } }) {
  const authFail = await requireAuth();
  if (authFail) return authFail;
  const customerId = ctx.params.customer_id;
  if (!customerId) return NextResponse.json({ ok: false, error: "missing_customer_id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const evalMdUrl: string | undefined = body.eval_md_url;
  const evalJsonUrl: string | undefined = body.eval_json_url;
  if (!evalMdUrl || !evalJsonUrl) {
    return NextResponse.json({ ok: false, error: "missing_eval_urls" }, { status: 400 });
  }

  await logEvent(customerId, "stage3b_started", {});

  // --- Load eval from Blob ------------------------------------------------
  let markdown: string;
  let reportData: any;
  try {
    [markdown, reportData] = await Promise.all([
      fetchText(evalMdUrl),
      fetchJson(evalJsonUrl),
    ]);
  } catch (e: any) {
    await setCustomerStatus(customerId, "failed", `stage3b_load: ${e.message}`);
    await logEvent(customerId, "stage3b_failed", { stage: "load_eval", error: e.message });
    return NextResponse.json({ ok: false, stage: "stage3b_load", error: e.message }, { status: 500 });
  }

  // --- Render docx + upload to Blob ---------------------------------------
  let render: { docxUrl: string; jsonUrl: string; mdUrl: string; bytes: number } | null = null;
  try {
    render = await renderAndUpload({
      cbCustomerId: customerId,
      reportData,
      markdown,
    });
    await logEvent(customerId, "docx_rendered", { bytes: render.bytes });
  } catch (e: any) {
    await logEvent(customerId, "render_failed", { error: e.message });
  }

  // --- Update DB with blob URLs + final ready state -----------------------
  await setCustomerReport(customerId, {
    report_blob_docx_url: render?.docxUrl ?? null,
    report_blob_json_url: render?.jsonUrl ?? null,
    report_blob_md_url: render?.mdUrl ?? null,
    status: "ready",
    failure_reason: null,
  });

  // --- Slack post ---------------------------------------------------------
  try {
    const cust = await getCustomer(customerId);
    const verdictNorm = (cust?.verdict ?? null) as "icp" | "review" | "not_icp" | null;
    const keyFlags = cust?.key_flags ?? [];
    const slackRes = await postCustomerReport({
      cbCustomerId: customerId,
      bizName: cust?.biz_name ?? null,
      amName: cust?.am_name ?? null,
      verdict: verdictNorm,
      needsAmCall: !!cust?.needs_am_call,
      oneLine: cust?.verdict_one_line ?? null,
      keyFlags,
      markdown,
      docxBlobUrl: render?.docxUrl ?? null,
    });
    if (slackRes.ts) {
      await setCustomerReport(customerId, {
        slack_channel_id: process.env.SLACK_CHANNEL_ID ?? null,
        slack_ts: slackRes.ts,
      });
    }
    await logEvent(customerId, "slack_posted", { ts: slackRes.ts ?? null, posted: slackRes.posted, file_url: slackRes.fileUrl });
  } catch (e: any) {
    console.error("[stage3b] slack post failed:", e.message);
    await logEvent(customerId, "slack_failed", { error: e.message });
  }

  await logEvent(customerId, "stage3b_done", {});
  return NextResponse.json({ ok: true, status: "ready" });
}
