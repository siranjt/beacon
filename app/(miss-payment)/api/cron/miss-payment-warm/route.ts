/**
 * Miss Payment Beacon — daily cache warmer.
 *
 * Hits /miss-payment/api/invoices?refresh=1 every morning so the
 * first user request lands instantly instead of waiting 20+ seconds
 * for Chargebee to walk all unpaid invoices + per-customer details.
 *
 * Vercel sends `Authorization: Bearer ${CRON_SECRET}` automatically.
 *
 * Scheduled in vercel.json — defaults to 02:30 UTC (matches the
 * standalone Missed Invoice Tracker's cadence, which is 08:00 IST).
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXTAUTH_URL || req.nextUrl.origin;

  // Vercel Deployment Protection is in front of /miss-payment/* in production.
  // Server-to-server cron calls bypass it via the project's "Protection
  // Bypass for Automation" token. Without this header, the inner fetch lands
  // on Vercel's auth wall and returns the 401 HTML page instead of our
  // route's JSON. Same pattern as lib/ai/eval-harness.ts.
  const headers: Record<string, string> = {};
  if (secret) {
    headers.authorization = `Bearer ${secret}`;
  }
  const protectionBypass = process.env.VERCEL_PROTECTION_BYPASS_TOKEN;
  if (protectionBypass) {
    headers["x-vercel-protection-bypass"] = protectionBypass;
    headers["x-vercel-set-bypass-cookie"] = "false";
  }

  const start = Date.now();
  try {
    const res = await fetch(`${origin}/miss-payment/api/invoices?refresh=1`, {
      headers,
      cache: "no-store",
    });
    const ok = res.ok;
    const text = ok ? "" : await res.text();
    return NextResponse.json({
      ok,
      status: res.status,
      ms: Date.now() - start,
      body: ok ? undefined : text.slice(0, 400),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e), ms: Date.now() - start },
      { status: 500 },
    );
  }
}
