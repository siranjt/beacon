"use client";

/**
 * Knowledge base doc editor — shared by /admin/knowledge/new and
 * /admin/knowledge/[id]. Markdown body + scope-tag picker + title +
 * slug + section. On submit, POSTs to /api/admin/knowledge or PATCHes
 * the existing doc. On delete (edit-only), DELETEs and routes back to
 * the list.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { KnowledgeDoc } from "@/lib/ai/knowledge";

const SCOPE_TAGS = [
  "all",
  "inbox",
  "customer-360",
  "customer-book",
  "performance-landing",
  "performance-report",
  "escalation-overview",
  "post-payment-book",
  "post-payment-customer",
  "miss-payment-overview",
];

interface Props {
  /** Existing doc when editing, null when creating new. */
  doc: KnowledgeDoc | null;
}

export default function KnowledgeEditor({ doc }: Props) {
  const router = useRouter();
  const isEdit = doc !== null;

  const [title, setTitle] = useState(doc?.title ?? "");
  const [slug, setSlug] = useState(doc?.slug ?? "");
  const [section, setSection] = useState(doc?.section ?? "");
  const [body, setBody] = useState(doc?.body ?? "");
  const [tags, setTags] = useState<string[]>(doc?.scope_tags ?? ["all"]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleTag(tag: string) {
    setTags((cur) => {
      if (cur.includes(tag)) {
        const next = cur.filter((t) => t !== tag);
        return next.length === 0 ? ["all"] : next;
      }
      return [...cur, tag];
    });
  }

  async function save() {
    setError(null);
    const payload = {
      slug: slug.trim(),
      title: title.trim(),
      section: section.trim() || null,
      body: body.trim(),
      scope_tags: tags,
    };
    if (!payload.title) return setError("Title is required");
    if (!payload.slug) return setError("Slug is required");
    if (!payload.body) return setError("Body is required");

    startTransition(async () => {
      try {
        const url = isEdit
          ? `/api/admin/knowledge/${doc!.id}`
          : "/api/admin/knowledge";
        const method = isEdit ? "PATCH" : "POST";
        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.detail || data.error || `HTTP ${res.status}`);
          return;
        }
        router.push("/admin/knowledge");
        router.refresh();
      } catch (e: any) {
        setError(String(e?.message || e));
      }
    });
  }

  async function onDelete() {
    if (!isEdit) return;
    if (!confirm(`Delete "${doc!.title}"? This can't be undone.`)) return;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/knowledge/${doc!.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.detail || data.error || `HTTP ${res.status}`);
          return;
        }
        router.push("/admin/knowledge");
        router.refresh();
      } catch (e: any) {
        setError(String(e?.message || e));
      }
    });
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    height: 36,
    padding: "0 12px",
    border: "1px solid #D4C29B",
    borderRadius: 8,
    background: "white",
    color: "var(--zoca-text)",
    fontSize: 13,
  };
  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--zoca-text-2)",
    fontWeight: 700,
    marginBottom: 6,
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 1rem" }}>
      <div style={{ marginBottom: 24 }}>
        <Link href="/admin/knowledge" style={{ color: "var(--zoca-text-2)", fontSize: 12, textDecoration: "none" }}>
          ← Back to all docs
        </Link>
        <h1
          style={{
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 28,
            fontWeight: 500,
            letterSpacing: "-0.015em",
            color: "var(--zoca-text)",
            margin: "8px 0 0",
          }}
        >
          {isEdit ? doc!.title : "New doc"}
        </h1>
        {isEdit && (
          <p style={{ color: "var(--zoca-text-2)", fontSize: 12, margin: "4px 0 0", fontFamily: "ui-monospace, monospace" }}>
            v{doc!.version} · last edited {doc!.last_edited_by || "—"}
          </p>
        )}
      </div>

      <div
        style={{
          background: "rgba(248, 239, 215, 0.85)",
          border: "1px solid #D4C29B",
          borderRadius: 14,
          padding: 24,
        }}
      >
        {error && (
          <div
            style={{
              background: "#F5C9B6",
              color: "#7C2D12",
              padding: "10px 14px",
              borderRadius: 8,
              marginBottom: 16,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
          <div>
            <label style={labelStyle}>Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Module 02 — ICP Framework"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Slug (url-safe id)</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              placeholder="icp-framework"
              disabled={isEdit}
              style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", opacity: isEdit ? 0.6 : 1 }}
            />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Section (optional, for citation precision)</label>
          <input
            type="text"
            value={section}
            onChange={(e) => setSection(e.target.value)}
            placeholder="The 4 carve-outs"
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Scopes (which agents see this doc)</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {SCOPE_TAGS.map((tag) => {
              const active = tags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  style={{
                    padding: "5px 12px",
                    borderRadius: 999,
                    border: active ? "1px solid #C8431D" : "1px solid #D4C29B",
                    background: active ? "#F5C9B6" : "white",
                    color: active ? "#7C2D12" : "var(--zoca-text-2)",
                    fontSize: 11,
                    fontFamily: "ui-monospace, monospace",
                    fontWeight: active ? 600 : 400,
                    cursor: "pointer",
                  }}
                >
                  {tag}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: "var(--zoca-text-3)", marginTop: 6 }}>
            <code style={{ background: "#EBE0C2", padding: "1px 5px", borderRadius: 3 }}>all</code> = doc shows up on every scope. Otherwise only on selected scopes.
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Body (markdown)</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="# Module 02 — Our ICP&#10;&#10;Three hard rules that must all pass before we sell:&#10;..."
            rows={20}
            style={{
              ...inputStyle,
              height: "auto",
              padding: 12,
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              fontSize: 13,
              lineHeight: 1.55,
              resize: "vertical",
            }}
          />
          <div style={{ fontSize: 11, color: "var(--zoca-text-3)", marginTop: 6 }}>
            Markdown supported. Keep under ~50KB; split larger docs across multiple rows with shared scopes.
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24, paddingTop: 16, borderTop: "1px solid #D4C29B" }}>
          <div>
            {isEdit && (
              <button
                type="button"
                onClick={onDelete}
                disabled={pending}
                style={{
                  background: "transparent",
                  border: "1px solid #C8431D",
                  color: "#7C2D12",
                  padding: "8px 16px",
                  borderRadius: 10,
                  fontSize: 12,
                  cursor: pending ? "not-allowed" : "pointer",
                  opacity: pending ? 0.5 : 1,
                }}
              >
                Delete
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link
              href="/admin/knowledge"
              style={{
                padding: "9px 18px",
                border: "1px solid #D4C29B",
                color: "var(--zoca-text)",
                borderRadius: 10,
                fontSize: 13,
                textDecoration: "none",
                background: "white",
              }}
            >
              Cancel
            </Link>
            <button
              type="button"
              onClick={save}
              disabled={pending}
              style={{
                background: "linear-gradient(135deg, #C8431D, #7C2D12)",
                color: "white",
                padding: "9px 18px",
                borderRadius: 10,
                fontWeight: 600,
                fontSize: 13,
                border: "none",
                cursor: pending ? "not-allowed" : "pointer",
                opacity: pending ? 0.6 : 1,
                boxShadow: "0 4px 12px rgba(200, 67, 29, 0.25)",
              }}
            >
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create doc"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
