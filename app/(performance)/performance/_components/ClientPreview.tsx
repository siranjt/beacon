"use client";

import { useEffect, useState } from "react";
import ReportPreview from "./ReportPreview";
import type { ComposedReport } from "@/lib/report/compose";

const SERIF = 'Georgia, "Times New Roman", "Times", serif';
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif";

/**
 * Client-side preview. Fetches the composed report from the preview JSON
 * endpoint when entityId changes, shows a skeleton during the fetch, and
 * renders the full ReportPreview when data arrives.
 *
 * Re-fetches on every entityId change so clicking a different recent card
 * swaps the preview content.
 */
export default function ClientPreview({ entityId }: { entityId: string | null }) {
  const [report, setReport] = useState<ComposedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!entityId) {
      setLoading(false);
      setReport(null);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/performance/api/preview/${entityId}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((json) => {
        if (alive) setReport(json.report);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [entityId]);

  if (!entityId) return <EmptyPreview />;
  if (loading) return <SkeletonPreview />;
  if (error) return <ErrorPreview message={error} />;
  if (!report) return null;
  return (
    <div key={entityId} className="pp-fade-in-up">
      <ReportPreview report={report} />
    </div>
  );
}

function EmptyPreview() {
  return (
    <div
      style={{
        background: "#F8EFD7",
        border: "1px dashed #D4C29B",
        borderRadius: 12,
        padding: "40px 20px",
        textAlign: "center",
        fontFamily: SERIF,
        color: "#6E5F50",
      }}
    >
      <div style={{ fontSize: 16, fontStyle: "italic" }}>
        Generate a report above or click a recent report to preview it here.
      </div>
    </div>
  );
}

function SkeletonPreview() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, opacity: 0.5 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <SkeletonCard height={170} />
        <SkeletonCard height={170} />
      </div>
      <SkeletonCard height={170} />
      <SkeletonCard height={240} />
      <SkeletonCard height={220} />
    </div>
  );
}

function SkeletonCard({ height }: { height: number }) {
  return (
    <div
      style={{
        background: "#F8EFD7",
        border: "1px solid #D4C29B",
        borderRadius: 12,
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: SANS,
        fontSize: 11,
        color: "#8B7A66",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      Loading…
    </div>
  );
}

function ErrorPreview({ message }: { message: string }) {
  return (
    <div
      style={{
        background: "#F5C9B6",
        border: "1px solid #7C2D12",
        borderRadius: 12,
        padding: "14px 16px",
        fontFamily: SERIF,
        color: "#7C2D12",
        fontSize: 13,
      }}
    >
      Preview unavailable: {message}
    </div>
  );
}
