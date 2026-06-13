/**
 * POST /api/keeper/voice-extract/confirm — Wave C voice-teach write path.
 *
 * Why this exists: the existing write path for Keeper facts is the
 * `add_fact_to_brain` Beam TOOL, which only runs as part of a Beam tool
 * loop. The mic-button confirm card is a direct REST surface — it needs an
 * HTTP endpoint that proxies the same writeBrainFact call. Reusing
 * writeBrainFact (not duplicating logic) means the voice-teach write still
 * runs the semantic-conflict gate, the version log, and the ranking-score
 * compute, exactly like add_fact_to_brain does.
 *
 * Source provenance: every fact written here lands with
 * `source_type: 'voice_teach'` so admins can filter the Validate inbox to
 * voice-taught facts when calibrating Haiku's classification prompt.
 *
 * Auth: AM / manager / admin. Confirm is the moment the AM commits — they
 * SAW the draft and clicked confirm — so source_ref + owning_am_email +
 * confirmed_by_email all carry the caller's email.
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import {
  writeBrainFact,
  SemanticConflictError,
} from "@/lib/brain/repo";
import {
  FIELD_CATALOG,
  categoryForSubcategory,
  isNamedField,
} from "@/lib/brain/types";
import type {
  TopicCategory,
  TopicSubcategory,
} from "@/lib/brain/types";
import { logUmbrellaActivity } from "@/lib/activity/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ConfirmBody {
  entity_id?: unknown;
  topic_category?: unknown;
  topic_subcategory?: unknown;
  field_name?: unknown;
  value?: unknown;
  /** When true, overrides the semantic-conflict gate on a near-duplicate. */
  force?: unknown;
}

const ALL_SUBCATEGORIES: ReadonlySet<TopicSubcategory> = new Set(
  Object.keys(FIELD_CATALOG) as TopicSubcategory[],
);
const ALL_CATEGORIES: ReadonlySet<TopicCategory> = new Set<TopicCategory>([
  "identity",
  "operational",
  "behavioral",
  "concerns",
  "relationship",
]);

export async function POST(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;
  if (!user?.email) {
    return NextResponse.json(
      { ok: false, error: "no email" },
      { status: 401 },
    );
  }

  let body: ConfirmBody;
  try {
    body = (await req.json()) as ConfirmBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const entityId =
    typeof body.entity_id === "string" ? body.entity_id.trim() : "";
  const topicCategoryRaw =
    typeof body.topic_category === "string" ? body.topic_category : "";
  const topicSubcategoryRaw =
    typeof body.topic_subcategory === "string" ? body.topic_subcategory : "";
  const fieldNameRaw =
    typeof body.field_name === "string" ? body.field_name.trim() : "";
  const value = typeof body.value === "string" ? body.value.trim() : "";
  const force = body.force === true;

  if (!entityId) {
    return NextResponse.json(
      { ok: false, error: "entity_id is required" },
      { status: 400 },
    );
  }
  if (!value) {
    return NextResponse.json(
      { ok: false, error: "value is required" },
      { status: 400 },
    );
  }
  if (!ALL_CATEGORIES.has(topicCategoryRaw as TopicCategory)) {
    return NextResponse.json(
      { ok: false, error: `invalid topic_category '${topicCategoryRaw}'` },
      { status: 400 },
    );
  }
  if (!ALL_SUBCATEGORIES.has(topicSubcategoryRaw as TopicSubcategory)) {
    return NextResponse.json(
      { ok: false, error: `invalid topic_subcategory '${topicSubcategoryRaw}'` },
      { status: 400 },
    );
  }
  const topicCategory = topicCategoryRaw as TopicCategory;
  const topicSubcategory = topicSubcategoryRaw as TopicSubcategory;

  const expectedCategory = categoryForSubcategory(topicSubcategory);
  if (expectedCategory !== topicCategory) {
    return NextResponse.json(
      {
        ok: false,
        error: `topic_category '${topicCategory}' does not match subcategory '${topicSubcategory}' (expected '${expectedCategory}')`,
      },
      { status: 400 },
    );
  }
  if (
    fieldNameRaw !== "other" &&
    !isNamedField(topicSubcategory, fieldNameRaw)
  ) {
    const allowed = FIELD_CATALOG[topicSubcategory].named_fields.join(", ");
    return NextResponse.json(
      {
        ok: false,
        error: `invalid field_name '${fieldNameRaw}' for subcategory '${topicSubcategory}'. Must be one of: ${allowed}, or 'other'.`,
      },
      { status: 400 },
    );
  }

  // Resolve entity → customer_id. Keeper rows key on Chargebee handle.
  let customerId: string | null = null;
  let bizname: string | null = null;
  try {
    const snap = await readLatestSnapshotV2();
    const cust = snap?.customers?.find((c) => c.entity_id === entityId);
    if (!cust) {
      return NextResponse.json(
        {
          ok: false,
          error: `Entity ${entityId.slice(0, 8)} not on the active book`,
        },
        { status: 404 },
      );
    }
    customerId = cust.customer_id ?? null;
    bizname = cust.company ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
  if (!customerId) {
    return NextResponse.json(
      {
        ok: false,
        error: `Entity ${entityId.slice(0, 8)} has no Chargebee customer_id`,
      },
      { status: 422 },
    );
  }

  // Reuse the same write path as add_fact_to_brain. source_type signals
  // provenance for the Validate inbox filter.
  try {
    const written = await writeBrainFact({
      customer_id: customerId,
      topic_category: topicCategory,
      topic_subcategory: topicSubcategory,
      field_name: fieldNameRaw,
      value,
      source_type: "voice_teach",
      source_ref: user.email,
      owning_am_email: user.email,
      confirmed_by_email: user.email,
      force_semantic_conflict: force,
    });
    if (!written) {
      return NextResponse.json(
        { ok: false, error: "Failed to write Keeper fact" },
        { status: 500 },
      );
    }

    void logUmbrellaActivity({
      email: user.email,
      role: user.role,
      am_name: user.am_name ?? null,
      agent: "customer",
      event_name: "keeper:voice_teach:confirm",
      surface: "customer-360",
      entity_id: entityId,
      metadata: {
        fact_id: written.fact_id,
        customer_id: customerId,
        topic_category: topicCategory,
        topic_subcategory: topicSubcategory,
        field_name: fieldNameRaw,
        version: written.current_version,
        force,
      },
    });

    return NextResponse.json({
      ok: true,
      fact: {
        fact_id: written.fact_id,
        customer_id: customerId,
        entity_id: entityId,
        bizname,
        topic_category: topicCategory,
        topic_subcategory: topicSubcategory,
        field_name: fieldNameRaw,
        value,
        version: written.current_version,
      },
    });
  } catch (e) {
    if (e instanceof SemanticConflictError) {
      return NextResponse.json(
        {
          ok: false,
          error: `Near-duplicate detected: "${e.conflicting_value.slice(0, 120)}" (${(e.similarity * 100).toFixed(0)}% similar). Resend with force=true to save anyway.`,
          conflict: {
            conflicting_fact_id: e.conflicting_fact_id,
            conflicting_value: e.conflicting_value,
            similarity: e.similarity,
          },
        },
        { status: 409 },
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
