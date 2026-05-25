/**
 * POST /api/ai/suggest — Beacon AI proactive recommendations. Phase E-9.
 *
 * Body:
 *   { scope: AiScope }
 *
 * Returns:
 *   { actions: SuggestedAction[], audience: string, generated_at: string }
 *
 * Auth: any signed-in zoca user.
 *
 * Now supports every non-hidden scope. Per-scope guidance baked into the
 * system prompt in lib/ai/suggest.ts. AM-role users get auto-filtered to
 * their own book for inbox + customer-book scopes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { suggestForScope } from "@/lib/ai/suggest";
import type { AiScope } from "@/lib/ai/scopes";
import { logUmbrellaActivity } from "@/lib/activity/log";
import { getRoleForEmail } from "@/lib/customer/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function isValidScope(s: unknown): s is AiScope {
  if (!s || typeof s !== "object") return false;
  const k = (s as { kind?: unknown }).kind;
  switch (k) {
    case "inbox":
    case "customer-book":
    case "performance-landing":
    case "escalation-overview":
    case "post-payment-book":
      return true;
    case "customer-360":
    case "performance-report":
      return typeof (s as { entityId?: unknown }).entityId === "string";
    case "post-payment-customer":
      return typeof (s as { cbCustomerId?: unknown }).cbCustomerId === "string";
    case "hidden":
      return false;
    default:
      return false;
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { scope?: AiScope };
  try {
    body = (await req.json()) as { scope?: AiScope };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.scope || !isValidScope(body.scope)) {
    return NextResponse.json({
      actions: [],
      audience: "(scope not supported)",
      generated_at: new Date().toISOString(),
    });
  }

  const amName = session.user?.am_name ?? null;
  const result = await suggestForScope(body.scope, email, amName);

  // Telemetry only fires when we have actual suggestions to show.
  if (result.actions.length > 0) {
    void logUmbrellaActivity({
      email,
      role: getRoleForEmail(email),
      am_name: amName,
      agent: "umbrella",
      event_name: "suggestion_offered",
      surface: "launcher",
      entity_id:
        body.scope.kind === "customer-360" || body.scope.kind === "performance-report"
          ? body.scope.entityId
          : null,
      metadata: {
        scope_kind: body.scope.kind,
        action_count: result.actions.length,
        kinds: result.actions.map((a) => a.kind),
      },
    });
  }

  return NextResponse.json(result, {
    headers: {
      // Short cache: suggestions could shift on each new fact or
      // conversation turn, so we don't want stale recommendations
      // sticking around long.
      "Cache-Control": "private, max-age=120",
    },
  });
}
