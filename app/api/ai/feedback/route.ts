/**
 * Beacon AI feedback endpoint — Phase E-12 (E-12.3).
 *
 * POST /api/ai/feedback
 *   Body: { turn_id: number, signal: "up" | "down", reason?: string }
 *
 * Records a thumbs up/down on an assistant turn. The handler:
 *   1. Looks up the turn to confirm it belongs to the signed-in user and was
 *      assistant-role (you can't react to your own user turn).
 *   2. Reads the active_fact_ids that were stored in the turn's metadata
 *      when the response was generated.
 *   3. Inserts the feedback row (idempotent on (turn_id, signal) via UNIQUE
 *      index — re-clicking the same vote is a no-op).
 *   4. Adjusts the confidence of every active fact: +0.05 on up, -0.15 on
 *      down (with auto-deactivation if confidence falls below 0.30).
 *
 * Safe defaults — every error path returns 200 with `ok: false` rather than
 * 500ing, because we never want a thumb click to feel broken to the user.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSql } from "@/lib/customer/postgres";
import { adjustFactConfidence } from "@/lib/ai/facts";
import { logUmbrellaActivity } from "@/lib/activity/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  turn_id?: unknown;
  signal?: unknown;
  reason?: unknown;
};

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const email = session.user.email;
  const rawRole = (session.user as { role?: string }).role;
  const role: "admin" | "manager" | "am" | null =
    rawRole === "admin" || rawRole === "manager" || rawRole === "am" ? rawRole : null;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const turnId = typeof body.turn_id === "number" ? body.turn_id : null;
  const signal = body.signal === "up" || body.signal === "down" ? body.signal : null;
  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;

  if (!turnId || !signal) {
    return NextResponse.json(
      { ok: false, error: "turn_id (number) and signal ('up'|'down') required" },
      { status: 400 },
    );
  }

  const sql = getSql();
  if (!sql) {
    return NextResponse.json({ ok: false, error: "no_db" }, { status: 200 });
  }

  // ---------------------------------------------------------------------------
  // 1) Verify the turn belongs to this user + is an assistant turn. Stops a
  //    user from voting on someone else's conversation by guessing IDs.
  // ---------------------------------------------------------------------------
  let turn: { metadata: Record<string, unknown> | null } | null = null;
  try {
    const rows = await sql`
      SELECT metadata
        FROM beacon_ai_conversations
       WHERE id = ${turnId}
         AND email = ${email}
         AND role = 'assistant'
       LIMIT 1
    `;
    const r = (rows as unknown as Array<{ metadata: Record<string, unknown> | null }>)[0];
    if (!r) {
      return NextResponse.json(
        { ok: false, error: "turn_not_found" },
        { status: 404 },
      );
    }
    turn = r;
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "lookup_failed" },
      { status: 500 },
    );
  }

  // ---------------------------------------------------------------------------
  // 2) Insert the feedback row. UNIQUE (turn_id, signal) means re-clicking
  //    the same vote is a no-op (ON CONFLICT DO NOTHING). Switching from up
  //    to down deletes the prior row first so the new vote takes effect.
  // ---------------------------------------------------------------------------
  let alreadyRecorded = false;
  try {
    // Remove the OPPOSITE signal if present (vote flip).
    const opposite: "up" | "down" = signal === "up" ? "down" : "up";
    await sql`
      DELETE FROM beacon_ai_feedback
       WHERE turn_id = ${turnId} AND signal = ${opposite}
    `;
    // Idempotent insert: if same signal already recorded, do nothing.
    const inserted = await sql`
      INSERT INTO beacon_ai_feedback (email, turn_id, signal, reason)
      VALUES (${email}, ${turnId}, ${signal}, ${reason})
      ON CONFLICT (turn_id, signal) DO NOTHING
      RETURNING id
    `;
    alreadyRecorded = (inserted as unknown as unknown[]).length === 0;
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "insert_failed" },
      { status: 500 },
    );
  }

  // ---------------------------------------------------------------------------
  // 3) Adjust fact confidences. Only fire on FIRST recording of this signal —
  //    re-clicks should be no-ops on the learning side too. (A user who
  //    quickly toggles up→down→up should net to a single up adjustment.)
  // ---------------------------------------------------------------------------
  let factsAdjusted = 0;
  if (!alreadyRecorded) {
    const meta = turn?.metadata ?? {};
    const activeFactIds = Array.isArray(
      (meta as { active_fact_ids?: unknown }).active_fact_ids,
    )
      ? ((meta as { active_fact_ids?: unknown[] }).active_fact_ids ?? []).filter(
          (id): id is number => typeof id === "number",
        )
      : [];
    if (activeFactIds.length > 0) {
      factsAdjusted = await adjustFactConfidence(email, activeFactIds, signal);
    }
  }

  // ---------------------------------------------------------------------------
  // 4) Telemetry — useful both as a usage metric (are AMs even using thumbs?)
  //    and as a learning signal for future prompt tuning.
  // ---------------------------------------------------------------------------
  void logUmbrellaActivity({
    email,
    role,
    am_name: null,
    agent: "umbrella",
    event_name: "claude_feedback",
    surface: "launcher",
    entity_id: null,
    metadata: {
      kind: "ai_feedback",
      turn_id: turnId,
      signal,
      facts_adjusted: factsAdjusted,
      had_reason: Boolean(reason),
      already_recorded: alreadyRecorded,
    },
  });

  return NextResponse.json({
    ok: true,
    factsAdjusted,
    alreadyRecorded,
  });
}
