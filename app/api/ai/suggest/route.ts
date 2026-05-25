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
 * v1 only supports scope kind "customer-360"; other scopes get an empty
 * actions array.
 *
 * Latency: typically 2-4 seconds (Haiku + structured JSON). The client
 * shows a loading state; the strip renders progressively.
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

function isCustomer360Scope(
  s: unknown,
): s is { kind: "customer-360"; entityId: string } {
  if (!s || typeof s !== "object") return false;
  const obj = s as { kind?: unknown; entityId?: unknown };
  return obj.kind === "customer-360" && typeof obj.entityId === "string";
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

  if (!body.scope || !isCustomer360Scope(body.scope)) {
    // v1 only customer-360 supported; everything else returns empty.
    return NextResponse.json({
      actions: [],
      audience: "(scope not supported)",
      generated_at: new Date().toISOString(),
    });
  }

  const result = await suggestForScope(body.scope, email);

  // Telemetry — fire when we have at least one action.
  if (result.actions.length > 0) {
    void logUmbrellaActivity({
      email,
      role: getRoleForEmail(email),
      am_name: session.user?.am_name ?? null,
      agent: "umbrella",
      event_name: "suggestion_offered",
      surface: "launcher",
      entity_id: body.scope.entityId,
      metadata: {
        scope_kind: body.scope.kind,
        action_count: result.actions.length,
        kinds: result.actions.map((a) => a.kind),
      },
    });
  }

  return NextResponse.json(result, {
    headers: {
      // Per-customer + per-user, lightly cached. Suggestions could shift
      // when the user adds a new /remember fact, so cache is short.
      "Cache-Control": "private, max-age=120",
    },
  });
}
