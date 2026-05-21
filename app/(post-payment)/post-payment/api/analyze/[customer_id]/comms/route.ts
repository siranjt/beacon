/**
 * Stage 2 of the analyze pipeline — comms CSV download + bundle completion.
 *
 * Receives the URL of the partial bundle from Stage 1, downloads + filters
 * the 5 comms CSVs (the heavy step, ~40s parallel), merges into the bundle,
 * saves the complete bundle to Blob, and triggers Stage 3.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { waitUntil } from "@vercel/functions";
import { commsForEntities } from "@/lib/post-payment/validator/metabase";
import { saveStageBundle, fetchJson } from "@/lib/post-payment/stage-store";
import { logEvent, setCustomerStatus } from "@/lib/post-payment/db/queries";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  return session ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

const COMMS_WINDOW_DAYS = Number(process.env.COMMS_WINDOW_DAYS ?? 90);

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

  // Load the light bundle from Blob
  let bundle: any;
  try {
    bundle = await fetchJson(bundleUrl);
  } catch (e: any) {
    await setCustomerStatus(customerId, "failed", `stage2_load: ${e.message}`);
    await logEvent(customerId, "stage2_failed", { error: e.message });
    return NextResponse.json({ ok: false, stage: "stage2_load", error: e.message }, { status: 500 });
  }

  await logEvent(customerId, "stage2_started", { entity_ids: bundle.entity_ids });

  const entityIds: string[] = bundle.entity_ids ?? [];
  if (!entityIds.length) {
    // Nothing to fetch comms for; skip directly to Stage 3 with empty comms
    bundle.comms = {};
    bundle.comms_summary = {};
  } else {
    try {
      const comms = await commsForEntities({
        entityIds: new Set(entityIds),
        cutoffUnix: bundle.t_created_unix,
        windowDays: COMMS_WINDOW_DAYS,
      });
      bundle.comms = comms;
      const summary: Record<string, number> = {};
      for (const [k, v] of Object.entries(comms)) summary[k.replace(/^comms_/, "")] = v.length;
      bundle.comms_summary = summary;
    } catch (e: any) {
      await setCustomerStatus(customerId, "failed", `stage2_comms: ${e.message}`);
      await logEvent(customerId, "stage2_failed", { error: e.message });
      return NextResponse.json({ ok: false, stage: "stage2_comms", error: e.message }, { status: 500 });
    }
  }

  // Save complete bundle (with comms) for Stage 3
  const completeBundleUrl = await saveStageBundle(customerId, bundle);
  await logEvent(customerId, "stage2_done", { bundle_url: completeBundleUrl, comms: bundle.comms_summary });

  triggerNextStage(
    `${baseUrl}/api/analyze/${customerId}/llm`,
    { bundle_url: completeBundleUrl },
    `stage2→stage3(${customerId})`,
  );

  return NextResponse.json({ ok: true, status: "stage2_done", next: "llm" });
}
