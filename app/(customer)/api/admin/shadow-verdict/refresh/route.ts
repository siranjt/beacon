/**
 * Shadow verdict — admin refresh endpoint. SV-11.
 *
 * Session-authed (manager+admin only) wrapper around `runShadowVerdict` so
 * the admin page's Refresh button can trigger a re-run without needing the
 * CRON_SECRET Bearer token. Mirrors the pattern used by /api/v2/refresh
 * (cookie auth, no secret required).
 *
 * Body (optional):
 *   { skip_compose?: boolean, limit_entities?: number, dry_run?: boolean }
 *
 * Default behavior:
 *   1. Re-run compose (so the LLM scores against fresh engine tiers).
 *   2. Run shadow verdict against the live book.
 *   3. Return the run summary.
 *
 * The route inherits maxDuration=800 via the existing cron route's vercel.json
 * entry — but this route is at a different path, so set it explicitly here.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail, isManagerOrAdmin } from "@/lib/customer/config";
import { runShadowVerdict } from "@/lib/customer/shadow-verdict/run";
import { composeSnapshot } from "@/lib/customer/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const role = getRoleForEmail(session.user.email);
  if (!isManagerOrAdmin(role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Empty body is fine — use defaults.
  }
  const skipCompose = body.skip_compose === true;
  const dryRun = body.dry_run === true;
  const limitRaw = body.limit_entities;
  const limit_entities =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : undefined;

  const result: {
    compose?: { ok: boolean; error?: string; elapsed_ms: number };
    shadow?: Awaited<ReturnType<typeof runShadowVerdict>>;
    error?: string;
  } = {};

  // Step 1: compose
  if (!skipCompose) {
    const t0 = Date.now();
    try {
      await composeSnapshot();
      result.compose = { ok: true, elapsed_ms: Date.now() - t0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[admin/shadow-verdict/refresh] compose failed:", msg);
      result.compose = { ok: false, error: msg, elapsed_ms: Date.now() - t0 };
      // Compose failure isn't fatal — the prior snapshot is still on disk,
      // we'll just be re-running shadow against stale engine tiers. Surface
      // the error in the response but don't abort.
    }
  }

  // Step 2: shadow run
  try {
    result.shadow = await runShadowVerdict({
      limit_entities,
      dry_run: dryRun,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[admin/shadow-verdict/refresh] shadow run failed:", msg);
    result.error = msg;
    return NextResponse.json(
      { ok: false, ...result },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ok: true, ...result },
    { headers: { "Cache-Control": "no-store" } },
  );
}
