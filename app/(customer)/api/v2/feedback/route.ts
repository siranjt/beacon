import { NextRequest, NextResponse } from "next/server";
import { writeSignalFeedback } from "@/lib/customer/postgres";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FeedbackBody = {
  entity_id?: string;
  signal_name?: string;
  am_name?: string;
  comment?: string;
};

/**
 * POST /api/v2/feedback
 * body: { entity_id, signal_name, am_name, comment? }
 *   → logs "this is wrong" feedback against a signal. Returns new row id.
 *     Powers the thumbs-down inside the why-flagged drawer.
 *
 * Phase 33.B — any signed-in role. The feedback is per-AM by design (the
 * am_name field identifies the AM who flagged it). No per-AM scope check
 * because admins + managers legitimately mark feedback while reviewing
 * other AMs' books, and AMs can only see signals on customers in their
 * own book in the first place (gated upstream).
 */
export async function POST(req: NextRequest) {
  const user = await getApiUser();
  const roleDenied = requireRole(user, "admin", "manager", "am");
  if (roleDenied) return roleDenied;

  let body: FeedbackBody | null = null;
  try {
    body = (await req.json()) as FeedbackBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { entity_id, signal_name, am_name, comment } = body || {};
  if (!entity_id || !signal_name || !am_name) {
    return NextResponse.json(
      { error: "entity_id, signal_name, am_name required" },
      { status: 400 },
    );
  }
  try {
    const id = await writeSignalFeedback({
      entity_id,
      signal_name,
      am_name,
      comment: comment ?? null,
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
