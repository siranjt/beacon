/**
 * Fast docx re-renderer — re-builds the Word document from the customer's
 * existing reportData JSON (stored in Vercel Blob) using the current
 * template.js renderer. No LLM call. No Chargebee/Metabase fetch. No Slack
 * repost by default.
 *
 * Use this when the renderer template has been updated and you want every
 * existing customer's docx regenerated — without paying $$$/3min to re-run
 * the analysis from scratch.
 *
 * POST /api/rerender/[customer_id]                  → re-render only
 * POST /api/rerender/[customer_id]?repost=true      → re-render and re-post to Slack
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchJson } from "@/lib/post-payment/stage-store";
import { renderAndUpload } from "@/lib/post-payment/render/render";
import { postCustomerReport } from "@/lib/post-payment/slack";
import { setCustomerReport, getCustomer, logEvent } from "@/lib/post-payment/db/queries";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  return session ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function POST(req: NextRequest, ctx: { params: { customer_id: string } }) {
  const authFail = await requireAuth();
  if (authFail) return authFail;
  const customerId = ctx.params.customer_id;
  if (!customerId) {
    return NextResponse.json({ ok: false, error: "missing_customer_id" }, { status: 400 });
  }
  const url = new URL(req.url);
  const repost = url.searchParams.get("repost") === "true";

  // Load existing customer + reportData
  const cust = await getCustomer(customerId);
  if (!cust) {
    return NextResponse.json({ ok: false, error: "customer_not_found" }, { status: 404 });
  }
  if (!cust.report_blob_json_url) {
    return NextResponse.json({
      ok: false,
      error: "no_report_data",
      hint: "This customer has no reportData yet. Run POST /api/analyze/" + customerId + " first.",
    }, { status: 400 });
  }

  await logEvent(customerId, "rerender_started", { repost });
  const t0 = Date.now();

  let reportData: any;
  try {
    reportData = await fetchJson(cust.report_blob_json_url);
  } catch (e: any) {
    await logEvent(customerId, "rerender_failed", { stage: "load_json", error: e.message });
    return NextResponse.json({ ok: false, stage: "load_json", error: e.message }, { status: 500 });
  }

  // Re-render and re-upload to the same blob key (overwrite).
  // We pass a non-empty placeholder for markdown — Vercel Blob's put()
  // rejects empty-string bodies. The actual narrative markdown isn't
  // available at rerender time (it lived only in the LLM's text content
  // block during the original run); the docx is the canonical artifact.
  let render: { docxUrl: string; jsonUrl: string; mdUrl: string; bytes: number };
  try {
    const placeholderMarkdown = `# ${cust.biz_name ?? customerId}\n\n_Document re-rendered from existing analysis data on ${new Date().toISOString()}. The structured JSON and Word document are the canonical artifacts; see report_blob_json_url and report_blob_docx_url._`;
    render = await renderAndUpload({
      cbCustomerId: customerId,
      reportData,
      markdown: placeholderMarkdown,
    });
    await logEvent(customerId, "rerender_done", {
      bytes: render.bytes,
      elapsed_ms: Date.now() - t0,
    });
  } catch (e: any) {
    await logEvent(customerId, "rerender_failed", { stage: "render", error: e.message });
    return NextResponse.json({ ok: false, stage: "render", error: e.message }, { status: 500 });
  }

  // Update DB with the new (same) URL — bumps updated_at, refreshes timestamp.
  // ALSO flip status back to "ready" so the dashboard recovers from any prior
  // "failed" or "processing" stuck state (we have a valid docx now).
  // ALSO re-extract verdict from reportData.exec — useful when restore-blob
  // populated fresh reportData and the DB verdict was empty/stale.
  const execLabel = reportData?.exec?.verdict_label?.toLowerCase()?.replace(/\s+/g, "_") ?? null;
  const verdictNorm: "icp" | "review" | "not_icp" | null =
    execLabel === "icp" ? "icp"
    : execLabel === "review" ? "review"
    : execLabel === "not_icp" ? "not_icp"
    : null;
  await setCustomerReport(customerId, {
    report_blob_docx_url: render.docxUrl,
    report_blob_json_url: render.jsonUrl,
    status: "ready",
    failure_reason: null,
    verdict: verdictNorm,
    verdict_one_line: reportData?.exec?.driver ?? null,
    needs_am_call: !!reportData?.exec?.recommended_action_label?.toLowerCase()?.includes("am"),
    key_flags: reportData?.exec?.reinforcing_flags ? [reportData.exec.reinforcing_flags] : [],
  });

  // Optional Slack repost
  let slackResult: any = { posted: false, reason: "repost=false (default)" };
  if (repost) {
    try {
      const verdict = (cust.verdict ?? null) as "icp" | "review" | "not_icp" | null;
      slackResult = await postCustomerReport({
        cbCustomerId: customerId,
        bizName: cust.biz_name ?? null,
        amName: cust.am_name ?? null,
        verdict,
        needsAmCall: !!cust.needs_am_call,
        oneLine: cust.verdict_one_line ?? null,
        keyFlags: cust.key_flags ?? [],
        markdown: `*Re-rendered* — ${cust.biz_name ?? customerId}. Verdict and analysis unchanged; only the Word document was regenerated against the latest template.`,
        docxBlobUrl: render.docxUrl,
      });
      await logEvent(customerId, "rerender_slack_posted", { ts: slackResult.ts ?? null });
    } catch (e: any) {
      await logEvent(customerId, "rerender_slack_failed", { error: e.message });
      slackResult = { posted: false, error: e.message };
    }
  }

  return NextResponse.json({
    ok: true,
    customer_id: customerId,
    elapsed_ms: Date.now() - t0,
    docx_url: render.docxUrl,
    json_url: render.jsonUrl,
    md_url: render.mdUrl,
    bytes: render.bytes,
    slack: slackResult,
  });
}
