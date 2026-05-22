import { NextRequest, NextResponse } from "next/server";
import {
  enrichTalkingPoints,
  type OneOnOnePrepData,
  type TalkingPoint,
} from "@/lib/customer/one-on-one";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RouteCtx = { params: { am: string } };

const VALID_KINDS = new Set(["celebrate", "constructive", "warning", "ask"]);

function coerceRules(raw: unknown): TalkingPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: TalkingPoint[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id) continue;
    if (typeof o.kind !== "string" || !VALID_KINDS.has(o.kind)) continue;
    if (typeof o.headline !== "string") continue;
    if (typeof o.detail !== "string") continue;
    const supporting_metric =
      o.supporting_metric &&
      typeof o.supporting_metric === "object" &&
      typeof (o.supporting_metric as Record<string, unknown>).label === "string" &&
      typeof (o.supporting_metric as Record<string, unknown>).value === "string"
        ? {
            label: (o.supporting_metric as Record<string, string>).label,
            value: (o.supporting_metric as Record<string, string>).value,
          }
        : undefined;
    out.push({
      id: o.id,
      kind: o.kind as TalkingPoint["kind"],
      headline: o.headline,
      detail: o.detail,
      supporting_metric,
    });
  }
  return out;
}

/**
 * POST /api/v2/manager/1on1/[am]/enrich
 *
 * Body: { rules: TalkingPoint[], context_lite: <slim OneOnOnePrepData> }
 * Returns: { ok, points: TalkingPoint[] }
 *
 * Soft-fails when ANTHROPIC_API_KEY is unset — returns rules unchanged.
 *
 * Phase 33.B — admin + manager only.
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const amName = decodeURIComponent(ctx.params.am || "");
  if (!amName) {
    return NextResponse.json({ ok: false, error: "Missing AM name" }, { status: 400 });
  }
  let body:
    | { rules?: unknown; context_lite?: unknown }
    | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const rules = coerceRules(body?.rules);
  if (!rules.length) {
    return NextResponse.json({ ok: true, points: [] });
  }
  // Best-effort context — caller sends a slim payload, we shape it into a
  // partial OneOnOnePrepData. The enricher only reads a few fields.
  const ctxIn = (body?.context_lite ?? {}) as Record<string, unknown>;
  const stub: OneOnOnePrepData = {
    am_name: amName,
    pod: typeof ctxIn.pod === "string" ? ctxIn.pod : null,
    generated_at: new Date().toISOString(),
    last_one_on_one: null,
    book_summary:
      (ctxIn.book_summary as OneOnOnePrepData["book_summary"]) ?? {
        total: 0,
        red: 0,
        yellow: 0,
        green: 0,
        mrr_total_cents: 0,
        mrr_at_risk_cents: 0,
      },
    actions_last_7d:
      (ctxIn.actions_last_7d as OneOnOnePrepData["actions_last_7d"]) ?? {
        total: 0,
        connected: 0,
        voicemail: 0,
        no_reach: 0,
        escalated: 0,
        action_rate_pct: 0,
      },
    wins_since_last_one_on_one: [],
    coaching:
      (ctxIn.coaching as OneOnOnePrepData["coaching"]) ?? null,
    talking_points_rule_based: rules,
  };

  try {
    const points = await enrichTalkingPoints(rules, stub);
    return NextResponse.json({ ok: true, points });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // On any failure, hand back the rules unchanged so the UI keeps working.
    return NextResponse.json({ ok: true, points: rules, warning: msg });
  }
}
