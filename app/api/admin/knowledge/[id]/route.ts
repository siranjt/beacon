/**
 * Beacon AI Knowledge Base — admin per-doc endpoint.
 *
 * GET    /api/admin/knowledge/<id>    → single KnowledgeDoc
 * PATCH  /api/admin/knowledge/<id>    → update fields (title/body/section/scope_tags)
 * DELETE /api/admin/knowledge/<id>    → delete the doc
 *
 * Admin-only. The page-level role check at /admin/knowledge gates UI
 * access; this route re-checks server-side.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
import {
  getDoc,
  updateDoc,
  deleteDoc,
  isAllowedScopeTag,
} from "@/lib/ai/knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  const role = getRoleForEmail(session.user.email);
  if (role !== "admin") {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { ok: true as const, email: session.user.email };
}

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  const doc = await getDoc(ctx.params.id);
  if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ doc });
}

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const patch: {
    title?: string;
    body?: string;
    section?: string | null;
    scope_tags?: string[];
    last_edited_by?: string;
  } = { last_edited_by: auth.email };

  if (typeof body.title === "string") patch.title = body.title.trim();
  if (typeof body.body === "string") patch.body = body.body.trim();
  if (body.section === null || typeof body.section === "string") {
    patch.section = body.section === null ? null : body.section.trim();
  }
  if (Array.isArray(body.scope_tags)) {
    const valid = body.scope_tags.filter(
      (t: unknown) => typeof t === "string" && isAllowedScopeTag(t),
    );
    if (valid.length > 0) patch.scope_tags = valid;
  }

  try {
    const doc = await updateDoc(ctx.params.id, patch);
    if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ doc });
  } catch (err: any) {
    return NextResponse.json(
      { error: "update_failed", detail: String(err?.message || err) },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const ok = await deleteDoc(ctx.params.id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
