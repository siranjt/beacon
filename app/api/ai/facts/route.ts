/**
 * Beacon AI user facts. Phase E-9 · Phase 2.
 *
 *   GET    /api/ai/facts                    — list active facts for current user
 *   GET    /api/ai/facts?include_inactive=1 — include deactivated facts too
 *   POST   /api/ai/facts  { fact: string }  — add an explicit fact
 *   DELETE /api/ai/facts?id=N               — soft-delete (deactivate) a fact
 *
 * Auth: any signed-in zoca user. Each user can only manage their own facts.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  addExplicitFact,
  deactivateFact,
  listFactsForUser,
} from "@/lib/ai/facts";
import { logUmbrellaActivity } from "@/lib/activity/log";
import { getRoleForEmail } from "@/lib/customer/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const includeInactive = url.searchParams.get("include_inactive") === "1";

  const facts = await listFactsForUser(email, { includeInactive });
  return NextResponse.json(
    { facts },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { fact?: string };
  try {
    body = (await req.json()) as { fact?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const fact = (body.fact ?? "").trim();
  if (!fact) {
    return NextResponse.json({ error: "fact is required" }, { status: 400 });
  }
  if (fact.length > 280) {
    return NextResponse.json(
      { error: "fact too long (max 280 chars)" },
      { status: 400 },
    );
  }

  const result = await addExplicitFact({ email, fact });
  if (!result) {
    return NextResponse.json(
      { error: "couldn't save fact" },
      { status: 500 },
    );
  }

  void logUmbrellaActivity({
    email,
    role: getRoleForEmail(email),
    am_name: session.user?.am_name ?? null,
    agent: "umbrella",
    event_name: "fact_remembered",
    surface: "launcher",
    metadata: {
      fact_preview: fact.slice(0, 80),
      reused: result.reused,
    },
  });

  return NextResponse.json({ ok: true, id: result.id, reused: result.reused });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const idStr = url.searchParams.get("id");
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "valid id required" }, { status: 400 });
  }
  const ok = await deactivateFact(email, id);
  if (ok) {
    void logUmbrellaActivity({
      email,
      role: getRoleForEmail(email),
      am_name: session.user?.am_name ?? null,
      agent: "umbrella",
      event_name: "fact_forgotten",
      surface: "launcher",
      metadata: { fact_id: id },
    });
  }
  return NextResponse.json({ ok });
}
