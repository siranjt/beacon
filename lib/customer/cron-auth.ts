import { NextRequest, NextResponse } from "next/server";

/**
 * Centralized cron auth check.
 *
 * Returns `null` if authorized, or a NextResponse (401/503) if rejected.
 *
 * Security notes:
 * - CRON_SECRET is REQUIRED. If unset we return 503, refusing to run rather
 *   than fall through to an unverifiable `x-vercel-cron` header check.
 *   The `x-vercel-cron` header can be set by any client; the only safe
 *   server-side gate is a Bearer token.
 * - Use a long random secret (e.g. `openssl rand -hex 32`).
 */
export function requireCronAuth(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        error:
          "CRON_SECRET environment variable not set — refusing to run cron without authentication",
      },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return null;
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
