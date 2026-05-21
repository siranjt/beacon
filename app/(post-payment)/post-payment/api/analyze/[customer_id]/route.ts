/**
 * Single-function analyze pipeline — consolidated from the old 4-stage chain.
 *
 * Why consolidated:
 *   The previous Stage 1 → Stage 2 (comms) → Stage 3a (LLM) → Stage 3b (render+Slack)
 *   chain used fire-and-forget HTTP triggers between stages. Each hop was a
 *   separate failure surface: function timeouts, internal-fetch routing,
 *   different DB connections per Lambda instance, stage-store Blob handoff,
 *   etc. We chased ~6 different symptoms and never got a clean end-to-end run.
 *
 * New approach:
 *   - POST returns 202 immediately with `{ ok: true, status: "queued" }`.
 *   - The full pipeline (validator → comms → LLM → docx → Slack) runs inside
 *     `waitUntil` so the function stays alive up to maxDuration without
 *     blocking the caller.
 *   - Each step writes its own event row + updates `customers.status` so the
 *     dashboard reflects progress.
 *   - With Fluid Compute enabled, we have ~300s. Typical end-to-end is 90–180s.
 *
 * The old /comms, /llm, /render sub-routes still exist but are no longer in
 * the trigger chain. They can be removed in a follow-up cleanup.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { waitUntil } from "@vercel/functions";
import { buildBundle } from "@/lib/post-payment/validator/bundle";
import { evaluate } from "@/lib/post-payment/evaluator/anthropic";
import { renderAndUpload } from "@/lib/post-payment/render/render";
import { postCustomerReport } from "@/lib/post-payment/slack";
import {
  setCustomerReport, setCustomerStatus, logEvent,
  upsertCustomerStub, getCustomer,
} from "@/lib/post-payment/db/queries";

/**
 * Auth gate: accepts EITHER a valid NextAuth session OR a matching
 * `x-zoca-cron-secret` header (used by the retry-pending cron to re-trigger
 * analyze for `pending_entity` customers without a user session). The cron
 * secret must match CRON_SECRET env var.
 */
async function requireAuth(req?: NextRequest): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  if (session) return null;
  const cronSecret = req?.headers.get("x-zoca-cron-secret");
  if (cronSecret && process.env.CRON_SECRET && cronSecret === process.env.CRON_SECRET) {
    return null;
  }
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export const runtime = "nodejs";
// Pro plan allows up to 800s per Serverless Function. Bundle (~80s with
// comms CSVs) + Sonnet (~200–280s) + render (~5s) + Slack (~5s) ≈ 300–370s
// worst case. 600s gives us ~2× headroom so retries from prompt-cache misses
// or slow Metabase responses don't get clipped.
export const maxDuration = 600;
export const dynamic = "force-dynamic";

function pickEntityFields(b: any) {
  const e = (b.entities ?? [])[0] ?? {};
  return {
    entity_id: e.entity_id ?? null,
    biz_name: e.bizname ?? null,
    primary_category: e.primary_category ?? null,
    locality: e.locality ?? null,
    state_code: e.state ?? null,
    country: e.country ?? null,
    ae_name: e.ae_name ?? null,
    am_name: e.am_name ?? null,
    lead_source_group: e.lead_source_group ?? null,
    lead_source: e.lead_source ?? null,
    open_tickets_30d: e.open_tickets_last_30_days ? Number(e.open_tickets_last_30_days) : null,
    churn_potential_flag: e.churn_potential_flag ?? null,
    total_monthly_revenue: e.total_monthly_revenue ? Number(e.total_monthly_revenue) : null,
  };
}

function pickReviewFields(rm: any) {
  if (!rm) return { total_reviews_at_onb: null, avg_rating_at_onb: null, five_star_reviews: null, predicted_6_month_leads: null };
  return {
    total_reviews_at_onb: rm.total_reviews_at_onboarding ? Number(rm.total_reviews_at_onboarding) : null,
    avg_rating_at_onb: rm.avg_rating_at_onboarding ? Number(rm.avg_rating_at_onboarding) : null,
    five_star_reviews: rm.five_star_reviews ? Number(rm.five_star_reviews) : null,
    predicted_6_month_leads: rm.predicted_6_month_leads ? Number(rm.predicted_6_month_leads) : null,
  };
}

function pickBookingFields(rows: any[]) {
  const bp = (rows ?? []).find(r => r["Platform Type"] === "BOOKING_PLATFORM" && r["Is Active"] === "true");
  return {
    booking_platform: bp?.["Platform Name"] ?? null,
    booking_platform_url: bp?.["Link"] ?? null,
    booking_platform_active: bp ? true : null,
  };
}

function deriveScope(b: any): "discovery_first_pay" | "discovery_addon" | "no_subscription" | "pre_floor" | "other_subscription" {
  if (b.pre_floor) return "pre_floor";
  if (!b.subscription) return "no_subscription";
  if (!b.discovery_match) return "other_subscription";
  return "discovery_first_pay";
}

/**
 * The full pipeline. Runs in waitUntil so the HTTP response goes out at the
 * top while this continues in the background. Logs an event at every step so
 * the diag endpoint shows exactly where it got to.
 */
async function runPipeline(customerId: string) {
  const t0 = Date.now();
  await logEvent(customerId, "pipeline_started", { ts_iso: new Date().toISOString() });

  // ===== Step 1: Build full bundle =====================================
  await setCustomerStatus(customerId, "processing");
  await logEvent(customerId, "bundle_starting", {});
  let bundle: any;
  try {
    bundle = await buildBundle(customerId);
    await logEvent(customerId, "bundle_done", {
      elapsed_ms: Date.now() - t0,
      pre_floor: bundle.pre_floor,
      discovery_match: bundle.discovery_match,
      has_subscription: !!bundle.subscription,
      entity_ids: bundle.entity_ids,
      comms: bundle.comms_summary,
    });
  } catch (e: any) {
    await setCustomerStatus(customerId, "failed", `bundle: ${e.message}`);
    await logEvent(customerId, "pipeline_failed", { stage: "bundle", error: e.message });
    return;
  }

  // Upsert customer row with real Chargebee data so subsequent FK / lookups resolve
  const cbCustomer = bundle.chargebee_customer ?? {};
  await upsertCustomerStub({
    cb_customer_id: customerId,
    email: cbCustomer.email ?? undefined,
    first_name: cbCustomer.first_name ?? undefined,
    last_name: cbCustomer.last_name ?? undefined,
    biz_name: cbCustomer.cf_entity_name ?? cbCustomer.company ?? undefined,
    cb_created_at: new Date(bundle.t_chargebee_unix * 1000).toISOString(),
    cb_channel: cbCustomer.channel ?? undefined,
    cb_payment_method: cbCustomer.payment_method?.type ?? undefined,
  });

  const scope = deriveScope(bundle);

  // Persist deterministic data either way
  await setCustomerReport(customerId, {
    scope,
    stripe_customer_id: bundle.stripe_customer?.id ?? null,
    stripe_created_at: bundle.t_stripe_unix ? new Date(bundle.t_stripe_unix * 1000).toISOString() : null,
    timestamp_mismatch_h: bundle.timestamp_mismatch_hours,
    timestamp_mismatch_flag: bundle.timestamp_mismatch_flag,
    sub_id: bundle.subscription?.id ?? null,
    sub_status: bundle.subscription?.status ?? null,
    sub_item_price_ids: (bundle.subscription?.subscription_items ?? []).map((i: any) => i.item_price_id),
    sub_billing_period: bundle.subscription?.billing_period ?? null,
    sub_billing_period_unit: bundle.subscription?.billing_period_unit ?? null,
    sub_total_cents: bundle.invoices?.[0]?.total ?? null,
    ...pickEntityFields(bundle),
    ...pickReviewFields(bundle.review_metrics),
    ...pickBookingFields(bundle.booking_platform_rows),
  });

  // Out-of-scope: short-circuit here
  if (scope !== "discovery_first_pay") {
    await setCustomerReport(customerId, { status: "out_of_scope", failure_reason: bundle.skip_reason });
    await logEvent(customerId, "out_of_scope", { reason: bundle.skip_reason, scope });
    return;
  }

  // Entity-id deferred: BaseSheet hasn't synced this customer yet AND Chargebee's
  // cf_entity_id custom field is empty. Without an entity_id, the comms fetch
  // returns 0 rows across all 5 channels, which makes the LLM hallucinate from
  // billing data alone — every such report came back garbage. Defer the LLM
  // call, mark the customer as pending_entity, and let the hourly retry cron
  // (/api/cron/retry-pending) pick it back up once BaseSheet has caught up.
  if (bundle.entity_id_pending) {
    await setCustomerReport(customerId, {
      status: "pending_entity",
      failure_reason: "entity_id_pending: BaseSheet has not synced this customer yet, and cf_entity_id on the Chargebee record is empty. Retrying hourly.",
    });
    await logEvent(customerId, "deferred_pending_entity", {
      cb_customer_id: customerId,
      cf_entity_id: bundle.chargebee_customer?.cf_entity_id ?? null,
      basesheet_rows: bundle.entities.length,
    });
    return;
  }

  // ===== Step 2: LLM evaluation ========================================
  await logEvent(customerId, "llm_starting", {
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
  });
  const llmT0 = Date.now();
  let evalResult;
  try {
    evalResult = await evaluate({ bundle });
    await logEvent(customerId, "llm_done", {
      elapsed_ms: Date.now() - llmT0,
      markdown_chars: evalResult.markdown.length,
    });
  } catch (e: any) {
    const elapsed = Date.now() - llmT0;
    await setCustomerStatus(customerId, "failed", `llm: ${e.message}`);
    await logEvent(customerId, "pipeline_failed", { stage: "llm", error: e.message, elapsed_ms: elapsed });
    return;
  }

  // Persist verdict immediately so dashboard reflects it even if render fails
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
  });

  // ===== Step 3: Render docx + upload ==================================
  await logEvent(customerId, "render_starting", {});
  let render: { docxUrl: string; jsonUrl: string; mdUrl: string; bytes: number } | null = null;
  try {
    render = await renderAndUpload({
      cbCustomerId: customerId,
      reportData: evalResult.reportData,
      markdown: evalResult.markdown,
    });
    await logEvent(customerId, "render_done", { bytes: render.bytes });
  } catch (e: any) {
    await logEvent(customerId, "render_failed", { error: e.message });
    // continue — render is non-fatal, we still post to Slack with markdown
  }

  await setCustomerReport(customerId, {
    report_blob_docx_url: render?.docxUrl ?? null,
    report_blob_json_url: render?.jsonUrl ?? null,
    report_blob_md_url: render?.mdUrl ?? null,
    status: "ready",
    failure_reason: null,
  });

  // ===== Step 4: Slack post ============================================
  await logEvent(customerId, "slack_starting", {});
  try {
    const cust = await getCustomer(customerId);
    const slackRes = await postCustomerReport({
      cbCustomerId: customerId,
      bizName: cust?.biz_name ?? null,
      amName: cust?.am_name ?? null,
      verdict: verdictNorm,
      needsAmCall: !!cust?.needs_am_call,
      oneLine: cust?.verdict_one_line ?? null,
      keyFlags,
      markdown: evalResult.markdown,
      docxBlobUrl: render?.docxUrl ?? null,
    });
    if (slackRes.ts) {
      await setCustomerReport(customerId, {
        slack_channel_id: process.env.SLACK_CHANNEL_ID ?? null,
        slack_ts: slackRes.ts,
      });
    }
    await logEvent(customerId, "slack_done", {
      ts: slackRes.ts ?? null,
      posted: slackRes.posted,
      file_url: slackRes.fileUrl,
    });
  } catch (e: any) {
    await logEvent(customerId, "slack_failed", { error: e.message });
  }

  await logEvent(customerId, "pipeline_done", {
    elapsed_ms: Date.now() - t0,
    verdict: verdictNorm,
  });
}

export async function POST(req: NextRequest, ctx: { params: { customer_id: string } }) {
  const authFail = await requireAuth(req);
  if (authFail) return authFail;
  const customerId = ctx.params.customer_id;
  if (!customerId) {
    return NextResponse.json({ ok: false, error: "missing_customer_id" }, { status: 400 });
  }

  // IDEMPOTENCY — by default, skip the full pipeline if this customer already
  // has a verdict or is out-of-scope. The pipeline is expensive (~3 minutes,
  // pays for Anthropic tokens). It should run ONCE per customer (when the
  // Chargebee webhook fires) and not re-run on every deploy.
  //
  // To force a re-run (e.g., for debugging, or after the LLM prompt has been
  // materially improved), pass ?force=true. To re-render the docx from the
  // existing reportData without re-running the LLM, use POST /api/rerender/[id]
  // instead — that's a 5-second operation.
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";
  if (!force) {
    const existing = await getCustomer(customerId).catch(() => null);
    if (existing && (existing.status === "ready" || existing.status === "out_of_scope")) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: `customer already ${existing.status} (verdict=${existing.verdict ?? "n/a"}). Pass ?force=true to re-run, or POST /api/rerender/${customerId} to just re-render the docx.`,
        customer_id: customerId,
        status: existing.status,
        verdict: existing.verdict,
      });
    }
  }

  // Create a stub customer row IMMEDIATELY so logEvent's FK is satisfied even
  // if the full bundle build hasn't run yet. cb_created_at is a placeholder
  // (NOW()) that gets overwritten by the real timestamp once bundle resolves.
  try {
    await upsertCustomerStub({
      cb_customer_id: customerId,
      cb_created_at: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({
      ok: false, stage: "stub", error: e?.message ?? String(e),
    }, { status: 500 });
  }
  await logEvent(customerId, "queued", { ts_iso: new Date().toISOString(), forced: force });
  await setCustomerStatus(customerId, "processing");

  // Kick off the full pipeline as background work. The response goes out as
  // soon as we return below; Vercel keeps the function alive (up to
  // maxDuration=300s with Fluid Compute) while runPipeline awaits each step.
  waitUntil(runPipeline(customerId).catch(async (e: any) => {
    await logEvent(customerId, "pipeline_crashed", {
      error: e?.message ?? String(e),
      stack: (e?.stack ?? "").split("\n").slice(0, 6).join("\n"),
    }).catch(() => undefined);
    await setCustomerStatus(customerId, "failed", `crash: ${e?.message ?? e}`)
      .catch(() => undefined);
  }));

  return NextResponse.json({ ok: true, status: "queued", customer_id: customerId }, { status: 202 });
}
