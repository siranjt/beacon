import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import {
  confirmCandidateFact,
  editAndConfirmCandidateFact,
  rejectCandidateFact,
  reclassifyCandidateFact,
  clearParentReviewFlag,
} from "@/lib/brain/repo";
import { categoryForSubcategory, FIELD_CATALOG } from "@/lib/brain/types";
import type {
  TopicCategory,
  TopicSubcategory,
} from "@/lib/brain/types";
import { logUmbrellaActivity } from "@/lib/activity/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ConfirmBody {
  action: "confirm";
}
interface EditConfirmBody {
  action: "edit_confirm";
  value: string;
}
interface RejectBody {
  action: "reject";
}
interface ReclassifyBody {
  action: "reclassify";
  topic_subcategory: TopicSubcategory;
  field_name: string;
  topic_category?: TopicCategory;
}
// SMART-K4 followup — explicit "child is fine as-is" action. Clears
// needs_parent_review without changing the row's value or confidence.
interface ClearReviewFlagBody {
  action: "clear_review_flag";
}
type ActionBody =
  | ConfirmBody
  | EditConfirmBody
  | RejectBody
  | ReclassifyBody
  | ClearReviewFlagBody;

/**
 * POST /api/v2/brain/validate/[fact_id]
 *
 *   Triage a single candidate fact. Body shape varies by action:
 *
 *   { "action": "confirm" }
 *   { "action": "edit_confirm", "value": "<refined value>" }
 *   { "action": "reject" }
 *   { "action": "reclassify", "topic_subcategory": "...", "field_name": "..." }
 *
 *   For reclassify, topic_category is auto-derived from the subcategory
 *   via FIELD_CATALOG, so the client doesn't need to supply it (will
 *   accept and validate if provided).
 *
 *   Auth: AM + manager + admin. AMs can only triage their own candidates
 *   (where owning_am_email matches their email); managers + admins can
 *   triage anything.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ fact_id: string }> },
) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "no email" }, { status: 401 });
  }

  const { fact_id } = await ctx.params;
  if (!fact_id) {
    return NextResponse.json(
      { ok: false, error: "fact_id required" },
      { status: 400 },
    );
  }

  let body: ActionBody;
  try {
    body = (await req.json()) as ActionBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object" || !("action" in body)) {
    return NextResponse.json(
      { ok: false, error: "missing action" },
      { status: 400 },
    );
  }

  // Branch by action.
  try {
    switch (body.action) {
      case "confirm": {
        const row = await confirmCandidateFact(fact_id, user.email);
        if (!row) {
          return NextResponse.json(
            { ok: false, error: "candidate not found or already triaged" },
            { status: 404 },
          );
        }
        void logUmbrellaActivity({
          email: user.email,
          role: user.role,
          am_name: user.am_name ?? null,
          agent: "customer",
          event_name: "brain_candidate:confirm",
          surface: "admin",
          entity_id: null,
          metadata: { fact_id, customer_id: row.customer_id },
        });
        return NextResponse.json({ ok: true, action: "confirm", fact: row });
      }

      case "edit_confirm": {
        if (typeof body.value !== "string" || !body.value.trim()) {
          return NextResponse.json(
            { ok: false, error: "value required for edit_confirm" },
            { status: 400 },
          );
        }
        const row = await editAndConfirmCandidateFact(
          fact_id,
          body.value.trim(),
          user.email,
        );
        if (!row) {
          return NextResponse.json(
            { ok: false, error: "candidate not found or already triaged" },
            { status: 404 },
          );
        }
        void logUmbrellaActivity({
          email: user.email,
          role: user.role,
          am_name: user.am_name ?? null,
          agent: "customer",
          event_name: "brain_candidate:edit_confirm",
          surface: "admin",
          entity_id: null,
          metadata: { fact_id, customer_id: row.customer_id, new_value: body.value.trim() },
        });
        return NextResponse.json({ ok: true, action: "edit_confirm", fact: row });
      }

      case "reject": {
        const ok = await rejectCandidateFact(fact_id, user.email);
        if (!ok) {
          return NextResponse.json(
            { ok: false, error: "candidate not found or already triaged" },
            { status: 404 },
          );
        }
        void logUmbrellaActivity({
          email: user.email,
          role: user.role,
          am_name: user.am_name ?? null,
          agent: "customer",
          event_name: "brain_candidate:reject",
          surface: "admin",
          entity_id: null,
          metadata: { fact_id },
        });
        return NextResponse.json({ ok: true, action: "reject" });
      }

      case "reclassify": {
        const sub = body.topic_subcategory;
        const fld = body.field_name;
        if (!sub || !(sub in FIELD_CATALOG)) {
          return NextResponse.json(
            { ok: false, error: `unknown subcategory: ${String(sub)}` },
            { status: 400 },
          );
        }
        const expectedCat = categoryForSubcategory(sub);
        const cat = body.topic_category ?? expectedCat;
        if (cat !== expectedCat) {
          return NextResponse.json(
            { ok: false, error: `category mismatch: ${String(cat)} vs ${expectedCat}` },
            { status: 400 },
          );
        }
        const validField =
          fld === "other" || FIELD_CATALOG[sub].named_fields.includes(fld);
        if (!validField) {
          return NextResponse.json(
            { ok: false, error: `invalid field_name for ${sub}: ${String(fld)}` },
            { status: 400 },
          );
        }
        const row = await reclassifyCandidateFact(
          fact_id,
          { topic_category: cat, topic_subcategory: sub, field_name: fld },
          user.email,
        );
        if (!row) {
          return NextResponse.json(
            { ok: false, error: "candidate not found or reclassify failed" },
            { status: 404 },
          );
        }
        void logUmbrellaActivity({
          email: user.email,
          role: user.role,
          am_name: user.am_name ?? null,
          agent: "customer",
          event_name: "brain_candidate:reclassify",
          surface: "admin",
          entity_id: null,
          metadata: {
            old_fact_id: fact_id,
            new_fact_id: row.fact_id,
            customer_id: row.customer_id,
            target_subcategory: sub,
            target_field_name: fld,
          },
        });
        return NextResponse.json({ ok: true, action: "reclassify", fact: row });
      }

      case "clear_review_flag": {
        const ok = await clearParentReviewFlag(fact_id);
        if (!ok) {
          return NextResponse.json(
            { ok: false, error: "fact not found or db unavailable" },
            { status: 404 },
          );
        }
        void logUmbrellaActivity({
          email: user.email,
          role: user.role,
          am_name: user.am_name ?? null,
          agent: "customer",
          event_name: "brain_candidate:clear_review_flag",
          surface: "admin",
          entity_id: null,
          metadata: { fact_id },
        });
        return NextResponse.json({ ok: true, action: "clear_review_flag" });
      }

      default: {
        return NextResponse.json(
          { ok: false, error: `unknown action: ${String((body as { action: unknown }).action)}` },
          { status: 400 },
        );
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
