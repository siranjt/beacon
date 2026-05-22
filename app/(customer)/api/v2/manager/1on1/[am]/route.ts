import { NextRequest, NextResponse } from "next/server";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import {
  buildOneOnOnePrep,
  writeOneOnOne,
  type OneOnOneActionItem,
} from "@/lib/customer/one-on-one";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RouteCtx = { params: { am: string } };

/**
 * GET /api/v2/manager/1on1/[am]
 *
 * Returns the full prep payload for the manager 1:1 view.
 *
 * Phase 33.B — admin + manager only.
 */
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const amName = decodeURIComponent(ctx.params.am || "");
  if (!amName) {
    return NextResponse.json(
      { ok: false, error: "Missing AM name" },
      { status: 400 },
    );
  }
  try {
    const snap = await readLatestSnapshotV2();
    if (!snap) {
      return NextResponse.json(
        { ok: false, error: "No snapshot available yet" },
        { status: 503 },
      );
    }
    const prep = await buildOneOnOnePrep(snap, amName);
    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      prep,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * POST /api/v2/manager/1on1/[am]
 *
 * Body: {
 *   manager_email?: string,
 *   notes?: string,
 *   action_items: OneOnOneActionItem[],
 *   talking_points_used?: string[]
 * }
 *
 * Persists the 1:1 log row with a metrics_snapshot of the AM's current view.
 *
 * Phase 33.B — admin + manager only.
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const amName = decodeURIComponent(ctx.params.am || "");
  if (!amName) {
    return NextResponse.json(
      { ok: false, error: "Missing AM name" },
      { status: 400 },
    );
  }

  let body:
    | {
        manager_email?: string;
        notes?: string;
        action_items?: unknown;
        talking_points_used?: unknown;
      }
    | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const safe = body || {};

  // Validate action_items
  const items: OneOnOneActionItem[] = [];
  if (Array.isArray(safe.action_items)) {
    for (const raw of safe.action_items) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      if (typeof o.text !== "string" || !o.text.trim()) continue;
      items.push({
        text: o.text.trim(),
        done: !!o.done,
        assignee: typeof o.assignee === "string" ? o.assignee : undefined,
      });
    }
  }

  const usedIds = Array.isArray(safe.talking_points_used)
    ? safe.talking_points_used.filter((v): v is string => typeof v === "string")
    : [];

  // Build metrics_snapshot from current snapshot view of this AM
  let metricsSnapshot: Record<string, unknown> | null = null;
  try {
    const snap = await readLatestSnapshotV2();
    if (snap) {
      const prep = await buildOneOnOnePrep(snap, amName);
      metricsSnapshot = {
        generated_at: prep.generated_at,
        book_summary: prep.book_summary,
        actions_last_7d: prep.actions_last_7d,
        wins_count: prep.wins_since_last_one_on_one.length,
        coaching: prep.coaching
          ? {
              untouched_7d: prep.coaching.red_untouched_7d.count,
              stale_14d: prep.coaching.stale_red_14d.count,
              noreach_streak: prep.coaching.noreach_streak_3plus.count,
              snooze_ignored: prep.coaching.snooze_ignored.count,
              total_red: prep.coaching.total_red,
              total_mrr_at_risk_cents: prep.coaching.total_mrr_at_risk_cents,
            }
          : null,
      };
    }
  } catch {
    metricsSnapshot = null;
  }

  try {
    const id = await writeOneOnOne({
      am_name: amName,
      manager_email:
        typeof safe.manager_email === "string" && safe.manager_email.trim()
          ? safe.manager_email.trim()
          : null,
      held_at: new Date().toISOString(),
      notes:
        typeof safe.notes === "string" && safe.notes.trim() ? safe.notes.trim() : null,
      action_items: items,
      talking_points_used: usedIds,
      metrics_snapshot: metricsSnapshot,
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
