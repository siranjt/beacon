/**
 * Beacon AI Knowledge Base — file upload endpoint.
 *
 * POST multipart/form-data with `file` field. Server parses by content-
 * type (.docx → mammoth, image → Vercel Blob + Claude Vision OCR, PDF →
 * not yet supported) and creates a beacon_ai_docs row via createDoc().
 *
 * Admin role required. Returns the new doc on success; the client can
 * then route to /admin/knowledge/<id> for the user to set scope_tags
 * and edit the auto-generated title before publishing.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
import { createDoc, getDocBySlug } from "@/lib/ai/knowledge";
import { parseUploadedFile } from "@/lib/ai/knowledge-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vision OCR + Vercel Blob put can take ~10-20s on a big screenshot.
// Cap at 60s so the user gets a clean error rather than a Vercel
// gateway timeout if vision is slow.
export const maxDuration = 60;

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

/**
 * If the auto-generated slug collides with an existing doc, append
 * `-2`, `-3`, etc. until free. Avoids the 409 from createDoc on a
 * second upload of the same filename.
 */
async function uniqueSlug(base: string): Promise<string> {
  let candidate = base || "uploaded-doc";
  let n = 1;
  while (true) {
    const existing = await getDocBySlug(candidate);
    if (!existing) return candidate;
    n++;
    candidate = `${base}-${n}`;
    if (n > 50) {
      // Defensive — practically never trips. Returning a random suffix.
      return `${base}-${Date.now()}`;
    }
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_form", detail: String((err as Error)?.message || err) },
      { status: 400 },
    );
  }

  const fileVal = form.get("file");
  if (!(fileVal instanceof Blob)) {
    return NextResponse.json({ error: "file_required" }, { status: 400 });
  }
  // Cast through unknown — runtime check above proves it's a File-like Blob.
  const file = fileVal as Blob & { name?: string };
  const filename = (file.name || "upload").trim();
  const contentType = file.type || "application/octet-stream";
  const sizeBytes = file.size;
  // Hard cap to keep things sensible. DOCX over 10MB, PNG over 8MB →
  // refuse. Most screenshots are <2MB; most internal docs are <1MB.
  const MAX_BYTES = 10 * 1024 * 1024;
  if (sizeBytes > MAX_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", detail: `file is ${Math.round(sizeBytes / 1024 / 1024)}MB — limit is 10MB` },
      { status: 413 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let parsed: Awaited<ReturnType<typeof parseUploadedFile>>;
  try {
    parsed = await parseUploadedFile(buffer, filename, contentType);
  } catch (err: any) {
    return NextResponse.json(
      { error: "parse_failed", detail: String(err?.message || err) },
      { status: 400 },
    );
  }

  // Section gets a useful default — the file extension. User can edit
  // after the upload lands at /admin/knowledge/<id>.
  const ext = (filename.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  const section = ext ? `Uploaded from .${ext}` : null;

  const slug = await uniqueSlug(parsed.slug);

  let doc;
  try {
    doc = await createDoc({
      slug,
      title: parsed.title,
      body: parsed.markdown,
      section,
      // Default to 'all' so the doc is immediately retrievable; user
      // narrows scope tags via the editor.
      scope_tags: ["all"],
      last_edited_by: auth.email,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: "create_failed", detail: String(err?.message || err) },
      { status: 500 },
    );
  }

  if (!doc) {
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }

  return NextResponse.json({ doc });
}
