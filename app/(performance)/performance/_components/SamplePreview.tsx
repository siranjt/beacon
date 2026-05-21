import { fetchEntityReportData } from "@/lib/report/fetchers";
import { composeReport } from "@/lib/report/compose";
import ReportPreview from "./ReportPreview";

const SERIF = 'Georgia, "Times New Roman", "Times", serif';
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif";

/**
 * Async server component that fetches the sample entity's data and renders
 * the full preview. Wrapped in <Suspense> by the parent so the hero + grid
 * render instantly; the preview streams in below.
 */
export default async function SamplePreview({ entityId }: { entityId: string }) {
  let data;
  try {
    data = await fetchEntityReportData(entityId);
  } catch (err) {
    return <PreviewError message={(err as Error).message} />;
  }
  if (!data) {
    return <PreviewError message="No data for sample entity." />;
  }
  const report = composeReport(data, {});
  return <ReportPreview report={report} />;
}

export function PreviewSkeleton() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        opacity: 0.6,
      }}
    >
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

function PreviewError({ message }: { message: string }) {
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
      Preview unavailable. {message}
    </div>
  );
}
