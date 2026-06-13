/**
 * POST /api/keeper/voice-extract — Wave C voice-teach extract endpoint.
 *
 * Why: KeeperMicButton + BeamMicButton transcribe speech in the browser
 * (zero-cost Web Speech API) and POST the raw transcript here. This route
 * (a) authenticates the AM, (b) optionally resolves entity_id → customer_id
 * + bizname so Haiku can ground its classification, and (c) calls the
 * voice-extract module to produce a single fact DRAFT.
 *
 * This route NEVER WRITES to the Keeper. It returns the draft to the
 * client, which displays a confirm card; the actual write happens through
 * the existing add-fact-to-brain Beam tool path (or its API equivalent)
 * AFTER the AM eyeballs and confirms the proposal. That keeps the trust
 * surface tight — voice is suggestive, never authoritative.
 *
 * Auth: AM / manager / admin. AMs scoped to their own book is enforced
 * downstream by add_fact_to_brain itself (it checks the snapshot's am_name
 * vs the caller); here we only need a Zoca-authenticated session.
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { extractFactFromTranscript } from "@/lib/keeper/voice-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface VoiceExtractRequestBody {
  /** Raw transcript text from window.SpeechRecognition. */
  transcript?: unknown;
  /**
   * Optional entity_id. When present, the route resolves the bizname from
   * snapshot so Haiku's classification has the customer name to ground on.
   * Also forwarded back in the response so the confirm-card UI knows
   * which customer the draft targets.
   */
  entity_id?: unknown;
}

const MAX_TRANSCRIPT_BYTES = 8000; // Defensive cap; module truncates too.

export async function POST(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;

  let body: VoiceExtractRequestBody;
  try {
    body = (await req.json()) as VoiceExtractRequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const transcript =
    typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return NextResponse.json(
      { ok: false, error: "transcript is required" },
      { status: 400 },
    );
  }
  if (transcript.length > MAX_TRANSCRIPT_BYTES) {
    return NextResponse.json(
      { ok: false, error: "transcript too large" },
      { status: 413 },
    );
  }

  const entityId =
    typeof body.entity_id === "string" && body.entity_id.trim().length > 0
      ? body.entity_id.trim()
      : null;

  // Resolve bizname + customer_id when we have an entity_id. Soft-fail —
  // a missing snapshot row just means Haiku classifies without the
  // grounding line, which is still acceptable.
  let bizname: string | null = null;
  let customerId: string | null = null;
  if (entityId) {
    try {
      const snap = await readLatestSnapshotV2();
      const cust = snap?.customers?.find((c) => c.entity_id === entityId);
      if (cust) {
        bizname = cust.company ?? null;
        customerId = cust.customer_id ?? null;
      }
    } catch {
      // Soft-fail to no grounding; classification still works.
    }
  }

  const draft = await extractFactFromTranscript(transcript, {
    bizname,
    am_email: user?.email ?? null,
  });

  if (draft.unparseable) {
    return NextResponse.json(
      {
        ok: true,
        unparseable: true,
        reason: draft.reason,
        entity_id: entityId,
        customer_id: customerId,
        bizname,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      unparseable: false,
      entity_id: entityId,
      customer_id: customerId,
      bizname,
      draft: {
        topic_category: draft.topic_category,
        topic_subcategory: draft.topic_subcategory,
        field_name: draft.field_name,
        value: draft.value,
        confidence: draft.confidence,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
