/**
 * Beacon AI memory endpoint. Phase E-9.
 *
 *   GET    /api/ai/memory?scope_key=...&include_cross=1
 *          → { scope: PersistedTurn[], cross: PersistedTurn[], total: number }
 *
 *   DELETE /api/ai/memory             — clears ALL of this user's history
 *   DELETE /api/ai/memory?scope_key=X — clears only that scope's history
 *
 * The AskPanel calls GET on open to hydrate from server (replacing the
 * old localStorage-only approach). DELETE is wired to the "Clear" button
 * in the drawer header.
 *
 * Auth: any signed-in zoca user. Each user can only read/write their own
 * conversations — the email comes from session, never from the URL.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  clearScopeMemory,
  clearUserMemory,
  countConversationsForUser,
  getRecentCrossScope,
  getScopeConversations,
} from "@/lib/ai/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const scopeKey = url.searchParams.get("scope_key") || "";
  const includeCross = url.searchParams.get("include_cross") === "1";

  // Run reads in parallel for snappier panel open. Each helper is
  // defensive — returns [] on any DB error.
  const [scope, cross, total] = await Promise.all([
    scopeKey ? getScopeConversations(email, scopeKey, 30) : Promise.resolve([]),
    includeCross
      ? getRecentCrossScope(email, scopeKey || null, 20)
      : Promise.resolve([]),
    countConversationsForUser(email),
  ]);

  return NextResponse.json(
    { scope, cross, total },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const scopeKey = url.searchParams.get("scope_key");

  const deleted = scopeKey
    ? await clearScopeMemory(email, scopeKey)
    : await clearUserMemory(email);

  return NextResponse.json({ ok: true, deleted });
}
