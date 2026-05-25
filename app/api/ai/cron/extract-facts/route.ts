/**
 * Beacon AI fact extraction cron. Phase E-9 · Phase 2.
 *
 * GET /api/ai/cron/extract-facts
 * Auth: Authorization: Bearer ${CRON_SECRET}
 *
 * Iterates every user with ≥ 6 turns of Beacon AI conversation in the
 * last 7 days. For each, runs runExtractionForUser() — Haiku distills
 * stable facts (preferences / context / behavior) from the user's
 * conversation history, dedupes against existing facts, and bumps
 * confidence on re-encountered ones.
 *
 * Schedule: every 12h via vercel.json cron. Cheap (Haiku, ~$0.002/user)
 * but bounded — typical Zoca team is ~25 active users, so a single run
 * costs ~$0.05.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  listUsersWithRecentActivity,
  runExtractionForUser,
} from "@/lib/ai/facts";
import { logUmbrellaActivity } from "@/lib/activity/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 503 },
    );
  }
  const authz = req.headers.get("authorization") || "";
  if (authz !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { ok: false, error: "ANTHROPIC_API_KEY not configured" },
      { status: 503 },
    );
  }

  const users = await listUsersWithRecentActivity();
  const results: Array<{
    email: string;
    extracted: number;
    added: number;
    reused: number;
    skipped_reason?: string;
  }> = [];

  // Sequential to avoid hammering Anthropic. Typical user count is ~25;
  // each extraction is ~3-5s; total ~2 minutes worst-case which fits in
  // the 5-minute Fluid-Compute window.
  for (const u of users) {
    try {
      const r = await runExtractionForUser(u.email);
      results.push({ email: u.email, ...r });

      // Log to telemetry (fire-and-forget).
      if (r.added > 0 || r.reused > 0) {
        void logUmbrellaActivity({
          email: u.email,
          role: null,
          am_name: null,
          agent: "umbrella",
          event_name: "fact_extracted",
          surface: "auth",
          metadata: {
            extracted: r.extracted,
            added: r.added,
            reused: r.reused,
          },
        });
      }
    } catch (err) {
      results.push({
        email: u.email,
        extracted: 0,
        added: 0,
        reused: 0,
        skipped_reason: err instanceof Error ? err.message.slice(0, 80) : "error",
      });
    }
  }

  const totals = results.reduce(
    (acc, r) => {
      acc.added += r.added;
      acc.reused += r.reused;
      acc.extracted += r.extracted;
      return acc;
    },
    { added: 0, reused: 0, extracted: 0 },
  );

  return NextResponse.json({
    ok: true,
    users_processed: users.length,
    totals,
    per_user: results,
  });
}
