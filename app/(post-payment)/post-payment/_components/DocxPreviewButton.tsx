"use client";

import { useState, useEffect } from "react";

/**
 * Button that opens an inline preview of the customer's docx report.
 *
 * Uses Microsoft's Office Online Viewer (view.officeapps.live.com) to render
 * the docx faithfully in an iframe — the same engine Microsoft uses for
 * Word Online. The docx URL must be publicly accessible (our Vercel Blob
 * URLs are).
 *
 * Inside the modal, a Download button is available so the user doesn't have
 * to close the preview to save the file.
 */
export function DocxPreviewButton({ docxUrl, filename }: { docxUrl: string; filename?: string }) {
  const [open, setOpen] = useState(false);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const viewerSrc = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(docxUrl)}`;
  const dlName = filename ?? docxUrl.split("/").pop() ?? "report.docx";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 border border-zoca-accent text-zoca-accent rounded hover:bg-zoca-info"
      >
        👁 Preview .docx
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(15,23,42,0.65)",
            zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center",
            padding: "24px",
          }}
        >
          <div style={{
            background: "white", borderRadius: 12, width: "min(1100px, 96vw)",
            height: "min(900px, 92vh)", display: "flex", flexDirection: "column",
            boxShadow: "0 20px 50px rgba(0,0,0,0.35)",
          }}>
            <div style={{
              padding: "12px 16px", borderBottom: "1px solid #e2e8f0",
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div style={{ fontWeight: 600, color: "#0f172a" }}>
                Preview · {dlName}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <a
                  href={docxUrl}
                  download={dlName}
                  style={{
                    padding: "6px 12px", background: "#0066cc", color: "white",
                    borderRadius: 6, textDecoration: "none", fontSize: 14, fontWeight: 500,
                  }}
                >
                  ↓ Download
                </a>
                <button
                  onClick={() => setOpen(false)}
                  style={{
                    padding: "6px 12px", background: "#f1f5f9", color: "#0f172a",
                    border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, cursor: "pointer",
                  }}
                >
                  Close
                </button>
              </div>
            </div>
            <iframe
              src={viewerSrc}
              style={{ flex: 1, width: "100%", border: 0, borderBottomLeftRadius: 12, borderBottomRightRadius: 12 }}
              title="Word document preview"
            />
          </div>
        </div>
      )}
    </>
  );
}
