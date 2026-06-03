/**
 * Beacon AI Knowledge Base — admin list + create endpoint.
 *
 * GET  /api/admin/knowledge?q=...&scope=...    → array of KnowledgeDoc
 * POST /api/admin/knowledge                    → create a new doc
 *
 * Admin-only. The page-level role check at /admin/knowledge gates UI
 * access; this route re-checks server-side so curl can't bypass.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
import {
  listDocs,
  createDoc,
  isAllowedScopeTag,
  ALLOWED_SCOPE_TAGS,
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

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const q = req.nextUrl.searchParams.get("q") || undefined;
  const scope = req.nextUrl.searchParams.get("scope") || undefined;
  const limit = Number(req.nextUrl.searchParams.get("limit")) || 100;

  const docs = await listDocs({ q, scope, limit });
  return NextResponse.json({ docs, allowed_scope_tags: ALLOWED_SCOPE_TAGS });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const slug = String(body.slug || "").trim();
  const title = String(body.title || "").trim();
  const docBody = String(body.body || "").trim();
  const section = body.section ? String(body.section).trim() : null;
  const scope_tags = Array.isArray(body.scope_tags) ? body.scope_tags : ["all"];

  if (!slug) return NextResponse.json({ error: "slug_required" }, { status: 400 });
  if (!/^[a-z0-9][a-z0-9\-]*$/.test(slug)) {
    return NextResponse.json(
      { error: "slug_format", detail: "slug must be lowercase alphanumeric with hyphens, starting with letter/digit" },
      { status: 400 },
    );
  }
  if (!title) return NextResponse.json({ error: "title_required" }, { status: 400 });
  if (!docBody) return NextResponse.json({ error: "body_required" }, { status: 400 });

  // Validate scope_tags against the allowed list. Invalid tags get
  // dropped silently (don't fail the whole request).
  const valid_tags = scope_tags.filter((t: unknown) => typeof t === "string" && isAllowedScopeTag(t));
  if (valid_tags.length === 0) valid_tags.push("all");

  try {
    const doc = await createDoc({
      slug,
      title,
      body: docBody,
      section,
      scope_tags: valid_tags,
      last_edited_by: auth.email,
    });
    if (!doc) {
      return NextResponse.json({ error: "create_failed" }, { status: 500 });
    }
    return NextResponse.json({ doc });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes("duplicate key") || msg.includes("unique")) {
      return NextResponse.json(
        { error: "slug_taken", detail: "a doc with that slug already exists" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "create_failed", detail: msg }, { status: 500 });
  }
}
