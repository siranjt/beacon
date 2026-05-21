/**
 * Stage 3a of the analyze pipeline — LLM evaluation only.
 *
 * Reads the complete bundle from Blob (saved by Stage 2), calls Anthropic
 * Claude to produce Markdown + structured JSON, saves the eval to Blob,
 * updates the DB with the verdict, and triggers Stage 3b (render + Slack).
 *
 * Split out from the old combined Stage 3 because the LLM call alone can
 * take 60–120s — keeping render + Slack in a separate function lets each
 * stage fit comfortably under Vercel's per-function timeout.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { waitUntil } from "@vercel/functions";
import { evaluate } from "@/lib/post-payment/evaluator/anthropic";
import { fetchJson, saveStageEval } from "@/lib/post-payment/stage-store";
import { setCustomerReport, setCustomerStatus, logEvent } from "@/lib/post-payment/db/queries";

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  return session ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export const runtime = "nodejs";
// LLM is the longest step. Vercel's Fluid Compute on Hobby supports up to
// ~800s on this project; 300s is comfortably safe for Sonnet (typically 30–60s)
// and Opus (typically 60–120s).
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function triggerNextStage(url: string, body: unknown, label: string) {
  const work = (async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      console.log(`[stage-trigger] ${label} → ${url} status=${res.status}`);
    } catch (e: any) {
      console.error(`[stage-trigger] ${label} → ${url} failed:`, e?.message ?? e);
    }
  })();
  waitUntil(work);
}

export async function POST(req: NextRequest, ctx: { params: { customer_id: string } }) {
  const authFail = await requireAuth();
  if (authFail) return authFail;
  const customerId = ctx.params.customer_id;
  if (!customerId) return NextResponse.json({ ok: false, error: "missing_customer_id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const bundleUrl: string | undefined = body.bundle_url;
  if (!bundleUrl) {
    return NextResponse.json({ ok: false, error: "missing_bundle_url" }, { status: 400 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.get("host")}`;

  // Load the complete bundle (with comms)
  let bundle: any;
  try {
    bundle = await fetchJson(bundleUrl);
  } catch (e: any) {
    await setCustomerStatus(customerId, "failed", `stage3a_load: ${e.message}`);
    await logEvent(customerId, "stage3a_failed", { error: e.message });
    return NextResponse.json({ ok: false, stage: "stage3a_load", error: e.message }, { status: 500 });
  }
  await logEvent(customerId, "stage3a_started", {});

  // --- LLM evaluation -----------------------------------------------------
  // Log a checkpoint BEFORE the LLM call so we can prove we reached this line
  // even if the function gets hard-killed by Vercel before evaluate() returns.
  await logEvent(customerId, "llm_call_starting", {
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    bundle_keys: Object.keys(bundle ?? {}).slice(0, 20),
  });
  const llmT0 = Date.now();
  let evalResult;
  try {
    evalResult = await evaluate({ bundle });
    await logEvent(customerId, "llm_eval_done", {
      markdown_chars: evalResult.markdown.length,
      elapsed_ms: Date.now() - llmT0,
    });
  } catch (e: any) {
    const elapsed = Date.now() - llmT0;
    await setCustomerStatus(customerId, "failed", `evaluator: ${e.message}`);
    await logEvent(customerId, "stage3a_failed", { stage: "evaluator", error: e.message, elapsed_ms: elapsed });
    return NextResponse.json({ ok: false, stage: "evaluator", error: e.message, elapsed_ms: elapsed }, { status: 500 });
  }

  // --- Persist verdict + key flags in DB now (so the dashboard reflects ---
  //    the analysis result even if Stage 3b lags or fails) ----------------
  const verdict = evalResult.reportData?.exec?.verdict_label?.toLowerCase()?.replace(/\s+/g, "_") ?? null;
  const verdictNorm: "icp" | "review" | "not_icp" | null =
    verdict === "icp" ? "icp"
    : verdict === "review" ? "review"
    : verdict === "not_icp" ? "not_icp"
    : null;
  const keyFlags: string[] = evalResult.reportData?.exec?.reinforcing_flags
    ? [evalResult.reportData.exec.reinforcing_flags] : [];

  await setCustomerReport(customerId, {
    verdict: verdictNorm,
    needs_am_call: !!evalResult.reportData?.exec?.recommended_action_label?.toLowerCase()?.includes("am"),
    verdict_one_line: evalResult.reportData?.exec?.driver ?? null,
    key_flags: keyFlags,
    status: "processing",
    failure_reason: null,
  });

  // --- Save eval to Blob so Stage 3b can pick it up -----------------------
  let evalUrls: { mdUrl: string; jsonUrl: string };
  try {
    evalUrls = await saveStageEval(customerId, {
      markdown: evalResult.markdown,
      reportData: evalResult.reportData,
    });
    await logEvent(customerId, "stage3a_done", { md_url: evalUrls.mdUrl, json_url: evalUrls.jsonUrl });
  } catch (e: any) {
    await setCustomerStatus(customerId, "failed", `stage3a_save: ${e.message}`);
    await logEvent(customerId, "stage3a_failed", { stage: "save_eval", error: e.message });
    return NextResponse.json({ ok: false, stage: "stage3a_save", error: e.message }, { status: 500 });
  }

  // --- Fire-and-forget Stage 3b (render + Slack) --------------------------
  triggerNextStage(
    `${baseUrl}/api/analyze/${customerId}/render`,
    { bundle_url: bundleUrl, eval_md_url: evalUrls.mdUrl, eval_json_url: evalUrls.jsonUrl },
    `stage3a→stage3b(${customerId})`,
  );

  return NextResponse.json({ ok: true, status: "stage3a_done", next: "render", verdict: verdictNorm });
}
