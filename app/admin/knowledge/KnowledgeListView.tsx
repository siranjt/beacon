"use client";

/**
 * Knowledge base admin list — client component. Renders the server-loaded
 * doc list with search + scope filter; on user input, re-queries the API
 * and updates the table without a full page reload.
 *
 * The new/edit/delete actions all route through /admin/knowledge/<id>
 * (or /admin/knowledge/new) — separate pages keep the list view simple.
 */

import { useState, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { KnowledgeDoc } from "@/lib/ai/knowledge";

interface Props {
  initialDocs: KnowledgeDoc[];
}

const SCOPE_LABELS: Record<string, string> = {
  all: "All scopes",
  inbox: "Inbox",
  "customer-360": "Customer 360",
  "customer-book": "Customer Book",
  "performance-landing": "Performance",
  "performance-report": "Performance Report",
  "escalation-overview": "Escalation",
  "post-payment-book": "Post-Payment Book",
  "post-payment-customer": "Post-Payment Customer",
  "miss-payment-overview": "Miss Payment",
};

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function KnowledgeListView({ initialDocs }: Props) {
  const router = useRouter();
  const [docs] = useState<KnowledgeDoc[]>(initialDocs);
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/admin/knowledge/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.doc) {
        setUploadError(data.detail || data.error || `HTTP ${res.status}`);
        return;
      }
      // Hand the user to the editor so they can review the auto-parsed
      // body + narrow the scope_tags before publishing.
      router.push(`/admin/knowledge/${data.doc.id}`);
      router.refresh();
    } catch (err: any) {
      setUploadError(String(err?.message || err));
    } finally {
      setUploading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return docs.filter((d) => {
      if (q) {
        const haystack = `${d.title} ${d.slug} ${d.section ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (scopeFilter) {
        if (!d.scope_tags.includes(scopeFilter)) return false;
      }
      return true;
    });
  }, [docs, query, scopeFilter]);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 24 }}>
        <div>
          <h1
            style={{
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: 28,
              fontWeight: 500,
              letterSpacing: "-0.015em",
              color: "var(--zoca-text)",
              margin: 0,
            }}
          >
            Knowledge base
          </h1>
          <p style={{ color: "var(--zoca-text-2)", fontSize: 13, margin: "4px 0 0" }}>
            Markdown docs that Beacon AI cites on every question. {docs.length} total.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx,.png,.jpg,.jpeg,.gif,.webp,image/*,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={onFilePicked}
            style={{ display: "none" }}
            disabled={uploading}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{
              background: "white",
              color: "var(--zoca-text)",
              padding: "9px 18px",
              borderRadius: 10,
              border: "1px solid #D4C29B",
              fontWeight: 500,
              fontSize: 13,
              cursor: uploading ? "not-allowed" : "pointer",
              opacity: uploading ? 0.5 : 1,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
            title="Upload a .docx file or a screenshot. Mammoth parses Word docs into markdown; screenshots get OCR'd via Claude Vision."
          >
            {uploading ? "⏳ Uploading…" : "↑ Add file"}
          </button>
          <Link
            href="/admin/knowledge/new"
            style={{
              background: "linear-gradient(135deg, #C8431D, #7C2D12)",
              color: "white",
              padding: "9px 18px",
              borderRadius: 10,
              fontWeight: 600,
              fontSize: 13,
              textDecoration: "none",
              boxShadow: "0 4px 12px rgba(200, 67, 29, 0.25)",
            }}
          >
            + New doc
          </Link>
        </div>
      </div>

      {uploadError && (
        <div
          style={{
            background: "#F5C9B6",
            color: "#7C2D12",
            padding: "10px 14px",
            borderRadius: 8,
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          Upload failed: {uploadError}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search title, slug, section…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            flex: 1,
            height: 36,
            padding: "0 12px",
            border: "1px solid #D4C29B",
            borderRadius: 8,
            background: "white",
            color: "var(--zoca-text)",
            fontSize: 13,
          }}
        />
        <select
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          style={{
            height: 36,
            padding: "0 10px",
            border: "1px solid #D4C29B",
            borderRadius: 8,
            background: "white",
            color: "var(--zoca-text)",
            fontSize: 13,
          }}
        >
          <option value="">All scopes</option>
          {Object.entries(SCOPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>

      <div
        style={{
          background: "rgba(248, 239, 215, 0.85)",
          border: "1px solid #D4C29B",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--zoca-text-2)", fontSize: 14 }}>
            {docs.length === 0 ? (
              <>
                No docs yet. <Link href="/admin/knowledge/new" style={{ color: "#C8431D" }}>Add the first one →</Link>
              </>
            ) : (
              "No docs match your filter."
            )}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#EBE0C2", color: "var(--zoca-text-2)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Title</th>
                <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Slug</th>
                <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Section</th>
                <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Scopes</th>
                <th style={{ textAlign: "right", padding: "12px 16px", fontWeight: 700 }}>Version</th>
                <th style={{ textAlign: "right", padding: "12px 16px", fontWeight: 700 }}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr
                  key={d.id}
                  style={{ borderTop: "1px solid #EBE0C2", cursor: "pointer", transition: "background 150ms" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#EBE0C2")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  onClick={() => {
                    window.location.href = `/admin/knowledge/${d.id}`;
                  }}
                >
                  <td style={{ padding: "12px 16px", fontWeight: 600, color: "var(--zoca-text)" }}>{d.title}</td>
                  <td style={{ padding: "12px 16px", fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--zoca-text-2)" }}>{d.slug}</td>
                  <td style={{ padding: "12px 16px", color: "var(--zoca-text-2)" }}>{d.section || <span style={{ opacity: 0.5 }}>—</span>}</td>
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {d.scope_tags.map((t) => (
                        <span
                          key={t}
                          style={{
                            background: t === "all" ? "#D8E1E6" : "#F5C9B6",
                            color: t === "all" ? "#1F3B47" : "#7C2D12",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: 10,
                            fontFamily: "ui-monospace, monospace",
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px", textAlign: "right", color: "var(--zoca-text-2)" }}>v{d.version}</td>
                  <td style={{ padding: "12px 16px", textAlign: "right", color: "var(--zoca-text-2)", fontSize: 11, whiteSpace: "nowrap" }}>{fmtDate(d.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
