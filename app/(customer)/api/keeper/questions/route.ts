/**
 * WAVE-B-3 — GET /api/keeper/questions
 *
 * Returns up to N pending keeper_questions rows for the strip mounted in
 * AskPanel. Session auth (admin / manager / am) — same as the rest of the
 * Keeper API surface.
 *
 * Query params:
 *   - customer_id (optional): Chargebee handle. Wins over entity_id.
 *   - entity_id   (optional): UUID, resolved to customer_id via the
 *                             latest customer snapshot.
 *   - limit       (optional, default 3, clamped 1..10): cap on rows.
 *
 * Response (always 200, even on soft-fail):
 *   { ok: true, questions: KeeperQuestionRow[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import {
  listPendingForCustomer,
  listPendingForUser,
  type KeeperQuestionRow,
} from "@/lib/keeper/questions-repo";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await getApiUser();
    const denied = requireRole(user, "admin", "manager", "am");
    if (denied) return denied;
    // requireRole's null-check already guarded — narrow for TS.
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Not authenticated" },
        { status: 401 },
      );
    }

    const url = new URL(req.url);
    const customerIdParam = (url.searchParams.get("customer_id") ?? "").trim();
    const entityIdParam = (url.searchParams.get("entity_id") ?? "").trim();
    const limitRaw = Number(url.searchParams.get("limit") ?? "3");
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(10, Math.floor(limitRaw)))
      : 3;

    let questions: KeeperQuestionRow[] = [];

    if (customerIdParam) {
      try {
        questions = await listPendingForCustomer(customerIdParam, limit);
      } catch {
        questions = [];
      }
    } else if (entityIdParam) {
      // Resolve entity_id → customer_id via snapshot. Keeper question
      // rows are keyed on Chargebee customer_id.
      let cbCustomerId: string | null = null;
      try {
        const snap = await readLatestSnapshotV2();
        const c = snap?.customers?.find((x) => x.entity_id === entityIdParam);
        cbCustomerId = c?.customer_id ?? null;
      } catch {
        cbCustomerId = null;
      }
      if (cbCustomerId) {
        try {
          questions = await listPendingForCustomer(cbCustomerId, limit);
        } catch {
          questions = [];
        }
      }
    } else {
      try {
        questions = await listPendingForUser(user.email, limit);
      } catch {
        questions = [];
      }
    }

    return NextResponse.json({ ok: true, questions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[/api/keeper/questions GET] uncaught:", msg);
    // Soft-fail to empty list — the strip must never break the parent UI.
    return NextResponse.json({ ok: true, questions: [] });
  }
}
