/**
 * AM tier feedback — POST endpoint. Phase SV-5.
 *
 * AMs click ✓ accurate / ✗ wrong on the tier they see for a customer.
 * One vote per (entity, am_email, calendar_day) — re-voting overwrites.
 *
 * Body: { entity_id, observed_tier: 'RED'|'YELLOW'|'GREEN',
 *         is_accurate: boolean, reason?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { upsertTierFeedback, getTodaysFeedbackForAm } from "@/lib/customer/shadow-verdict/repo";
import type { Tier } from "@/lib/customer/shadow-verdict/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIERS = new Set<Tier>(["RED", "YELLOW", "GREEN"]);

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const amEmail = session.user.email.toLowerCase();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const entity_id = typeof b.entity_id === "string" ? b.entity_id : null;
  const observed_tier = typeof b.observed_tier === "string" ? b.observed_tier : null;
  const is_accurate = b.is_accurate;
  const reasonRaw = b.reason;
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim().slice(0, 500) : null;

  if (!entity_id || !observed_tier || !TIERS.has(observed_tier as Tier)) {
    return NextResponse.json({ error: "entity_id + observed_tier required" }, { status: 400 });
  }
  if (typeof is_accurate !== "boolean") {
    return NextResponse.json({ error: "is_accurate must be boolean" }, { status: 400 });
  }

  try {
    await upsertTierFeedback({
      entity_id,
      am_email: amEmail,
      observed_tier: observed_tier as Tier,
      is_accurate,
      reason,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[tier-feedback] write failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rows = await getTodaysFeedbackForAm(session.user.email.toLowerCase());
  return NextResponse.json(
    { rows },
    { headers: { "Cache-Control": "no-store" } },
  );
}
