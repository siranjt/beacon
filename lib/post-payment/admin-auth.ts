/**
 * Dual-auth helper for post-payment admin routes (Phase E-7 wiring fixes).
 *
 * Admin endpoints — delete-customer, restore-blob, rerender — need to be
 * callable from two contexts:
 *
 *   1. The dashboard UI (browser, signed-in via NextAuth)
 *   2. Ops scripts running from a developer workstation, curl, or a
 *      Vercel cron (no browser session — uses a shared secret)
 *
 * Previously each route ran only a NextAuth check, which meant curl /
 * cron callers got a 401 even with the right secret. Now we accept either:
 *
 *   - a valid NextAuth session, OR
 *   - `Authorization: Bearer ${CRON_SECRET}` header
 *
 * If CRON_SECRET is unset in the environment, the bearer-token path is
 * disabled (only NextAuth wins) — same posture as `requireCronAuth` for
 * the cron routes. This means a misconfigured deploy fails closed
 * rather than silently allowing unauthenticated curl traffic.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function requireAdminAuth(
  req: NextRequest,
): Promise<NextResponse | null> {
  // Path 1 — bearer token (ops / cron). Constant-time-ish compare is fine
  // here because the secret never appears in URLs or logs.
  const authz = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && authz === `Bearer ${expected}`) {
    return null;
  }

  // Path 2 — NextAuth session (browser).
  const session = await getServerSession(authOptions);
  if (session) return null;

  return NextResponse.json(
    {
      error: "unauthorized",
      hint:
        "This endpoint requires either a signed-in NextAuth session or " +
        "the `Authorization: Bearer ${CRON_SECRET}` header.",
    },
    { status: 401 },
  );
}
