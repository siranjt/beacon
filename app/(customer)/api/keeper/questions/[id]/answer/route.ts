/**
 * WAVE-B-3 — POST /api/keeper/questions/[id]/answer
 *
 * AM types the answer in the strip; we write a confirmed Keeper fact and
 * mark the question answered, binding the new fact_id back to the
 * question row for audit.
 *
 * Body:
 *   {
 *     answer_value: string,         // the fact value (free text)
 *     topic_subcategory: string,    // valid TopicSubcategory
 *     field_name: string,           // FIELD_CATALOG named field OR 'other'
 *     topic_category?: string,      // optional override — defaults to the
 *                                    // expected category for the subcategory
 *   }
 *
 * Responses:
 *   200  { ok: true, fact, question }
 *   400  { ok: false, error }       — bad body / unknown subcategory
 *   404  { ok: false, error }       — question id missing OR already terminal
 *   409  { ok: false, error: 'semantic_conflict', conflict: {...} } — Wave-2b
 *        semantic-dedup throws; UI can offer "Save anyway" by calling
 *        writeBrainFact directly (this endpoint deliberately doesn't take a
 *        force flag; "Save anyway" routes through the Brain panel write).
 *   500  on any uncaught error.
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { getById, markAnswered } from "@/lib/keeper/questions-repo";
import { writeBrainFact, SemanticConflictError } from "@/lib/brain/repo";
import {
  categoryForSubcategory,
  FIELD_CATALOG,
  type TopicCategory,
  type TopicSubcategory,
} from "@/lib/brain/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_CATEGORIES = new Set<TopicCategory>([
  "identity",
  "operational",
  "behavioral",
  "concerns",
  "relationship",
]);

function isValidSubcategory(s: string): s is TopicSubcategory {
  return Object.prototype.hasOwnProperty.call(FIELD_CATALOG, s);
}

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } },
) {
  try {
    const user = await getApiUser();
    const denied = requireRole(user, "admin", "manager", "am");
    if (denied) return denied;
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Not authenticated" },
        { status: 401 },
      );
    }

    const id = Number(ctx.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json(
        { ok: false, error: "invalid question id" },
        { status: 400 },
      );
    }

    let body: {
      answer_value?: unknown;
      topic_subcategory?: unknown;
      field_name?: unknown;
      topic_category?: unknown;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "invalid JSON body" },
        { status: 400 },
      );
    }

    const answer_value =
      typeof body.answer_value === "string" ? body.answer_value.trim() : "";
    const topic_subcategory =
      typeof body.topic_subcategory === "string"
        ? body.topic_subcategory.trim()
        : "";
    const field_name =
      typeof body.field_name === "string" ? body.field_name.trim() : "";

    if (!answer_value) {
      return NextResponse.json(
        { ok: false, error: "answer_value required" },
        { status: 400 },
      );
    }
    if (!isValidSubcategory(topic_subcategory)) {
      return NextResponse.json(
        { ok: false, error: `unknown topic_subcategory: ${topic_subcategory}` },
        { status: 400 },
      );
    }
    if (!field_name) {
      return NextResponse.json(
        { ok: false, error: "field_name required" },
        { status: 400 },
      );
    }

    const expectedCategory = categoryForSubcategory(topic_subcategory);
    const topic_category: TopicCategory =
      typeof body.topic_category === "string" &&
      VALID_CATEGORIES.has(body.topic_category as TopicCategory)
        ? (body.topic_category as TopicCategory)
        : expectedCategory;
    if (topic_category !== expectedCategory) {
      return NextResponse.json(
        {
          ok: false,
          error: `topic_category mismatch: ${topic_category} does not match expected ${expectedCategory} for subcategory ${topic_subcategory}`,
        },
        { status: 400 },
      );
    }

    const question = await getById(id);
    if (!question) {
      return NextResponse.json(
        { ok: false, error: "question not found" },
        { status: 404 },
      );
    }
    if (question.status !== "pending") {
      return NextResponse.json(
        { ok: false, error: `question already ${question.status}` },
        { status: 404 },
      );
    }
    if (!question.customer_id) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "this question has no customer_id binding — cannot write a Keeper fact from it",
        },
        { status: 400 },
      );
    }

    let fact;
    try {
      fact = await writeBrainFact({
        customer_id: question.customer_id,
        topic_category,
        topic_subcategory,
        field_name,
        value: answer_value,
        // AM typed the answer in the Keeper-question strip — source_type
        // = 'manual' (not 'voice_teach', not 'beacon_ai_extracted'). The
        // strip writes are first-class AM-authored facts, so we also
        // confirm them in the same call.
        source_type: "manual",
        source_ref: `keeper_question:${question.id}`,
        owning_am_email: user.email,
        confirmed_by_email: user.email,
      });
    } catch (e) {
      if (e instanceof SemanticConflictError) {
        return NextResponse.json(
          {
            ok: false,
            error: "semantic_conflict",
            conflict: {
              conflicting_fact_id: e.conflicting_fact_id,
              conflicting_value: e.conflicting_value,
              similarity: e.similarity,
              proposed_value: e.proposed_value,
            },
          },
          { status: 409 },
        );
      }
      throw e;
    }

    if (!fact) {
      return NextResponse.json(
        { ok: false, error: "fact write returned null" },
        { status: 500 },
      );
    }

    await markAnswered(question.id, fact.fact_id, user.email);

    return NextResponse.json({ ok: true, fact, question });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[/api/keeper/questions/[id]/answer POST] uncaught:", msg);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 },
    );
  }
}
