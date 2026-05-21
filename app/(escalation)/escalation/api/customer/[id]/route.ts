import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildContext } from "@/lib/escalation/enrichment";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  return session ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

// GET /api/customer/<idOrEmailOrEntity> — quick lookup, no agent call.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const authFail = await requireAuth();
  if (authFail) return authFail;

  const id = decodeURIComponent(params.id);
  const looksLikeEmail = id.includes("@");
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  try {
    const ctx = await buildContext({
      text: "(lookup only)",
      customerHint: looksLikeEmail
        ? { email: id }
        : looksLikeUuid
          ? { entityId: id }
          : { customerId: id },
    });
    return NextResponse.json({ ok: true, context: ctx });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Internal error" }, { status: 500 });
  }
}
