import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchEntityReportData } from "@/lib/report/fetchers";
import { composeReport } from "@/lib/report/compose";
import { BeaconAmbient } from "@/components/BeaconAmbient";
import ReportPreview from "../../_components/ReportPreview";
import RecordRecentReport from "../../_components/RecordRecentReport";

export const dynamic = "force-dynamic";

const SERIF = 'Georgia, "Times New Roman", "Times", serif';
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif";

const BRASS = "#D9A441";
const BRASS_DEEP = "#B8852E";
const TEXT = "#2B1F14";
const MUTED = "#6E5F50";
const FADED = "#8B7A66";
const BORDER = "#D4C29B";
const SURFACE = "#F8EFD7";

/**
 * Full-screen per-entity report. Uses the same ReportPreview component as the
 * landing-page sample, but with the real fetched entity data plus a compact
 * sticky header (back to /performance + Download DOCX) on top.
 */
export default async function ReportPage({
  params,
}: {
  params: { entityId: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }

  const entityId = params.entityId;

  let data;
  try {
    data = await fetchEntityReportData(entityId);
  } catch (err) {
    return <ErrorState entityId={entityId} message={(err as Error).message} />;
  }
  if (!data) {
    return (
      <ErrorState
        entityId={entityId}
        message="No location found for this entity_id in gbp.locations. Double-check the UUID."
      />
    );
  }

  const report = composeReport(data, {});
  const i = report.identity;

  return (
    <main style={{ position: "relative", minHeight: "100vh" }}>
      <BeaconAmbient />
      <div style={{ position: "relative", zIndex: 10, padding: "32px 40px 56px" }}>
      {/* Top bar — sticky utility row */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 0",
          marginBottom: 16,
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <Link
          href="/performance"
          style={{
            color: MUTED,
            textDecoration: "none",
            fontSize: 13,
            fontFamily: SANS,
          }}
        >
          ← Back to Performance Beacon
        </Link>
        <a
          href={`/performance/api/report/${entityId}/docx`}
          style={{
            background: BRASS,
            color: TEXT,
            textDecoration: "none",
            padding: "8px 16px",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.02em",
            border: `1px solid ${BRASS_DEEP}`,
            fontFamily: SANS,
          }}
        >
          Download as Word
        </a>
      </header>

      {/* Report header */}
      <section style={{ marginBottom: 22 }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: FADED,
            fontFamily: SANS,
            marginBottom: 8,
          }}
        >
          Performance Beacon · {report.reportMonth}
        </div>
        <h1
          style={{
            margin: 0,
            fontFamily: SERIF,
            fontSize: 34,
            fontWeight: 500,
            color: TEXT,
            letterSpacing: "-0.015em",
            lineHeight: 1.1,
          }}
        >
          {i.title}
        </h1>
        <p
          style={{
            margin: "6px 0 0",
            color: MUTED,
            fontStyle: "italic",
            fontFamily: SERIF,
            fontSize: 15,
          }}
        >
          Local SEO &amp; growth report
        </p>
        <p
          style={{
            margin: "6px 0 0",
            color: FADED,
            fontSize: 12,
            fontFamily: SANS,
          }}
        >
          {i.city ? `${i.city}${i.state ? ", " + i.state : ""}` : "Unknown location"}
          {i.verticalDisplay ? ` · ${i.verticalDisplay}` : ""}
        </p>
      </section>

      <ReportPreview report={report} />

      <RecordRecentReport
        entityId={entityId}
        bizname={i.title}
        vertical={i.verticalDisplay ?? "Report"}
        location={[i.city, i.state].filter(Boolean).join(", ")}
      />
      </div>
    </main>
  );
}

function ErrorState({
  entityId,
  message,
}: {
  entityId: string;
  message: string;
}) {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "48px 24px",
        fontFamily: SERIF,
        color: TEXT,
      }}
    >
      <Link
        href="/performance"
        style={{
          color: MUTED,
          textDecoration: "none",
          fontSize: 13,
          fontFamily: SANS,
        }}
      >
        ← Back to Performance Beacon
      </Link>
      <h1
        style={{
          marginTop: 24,
          fontSize: 28,
          fontWeight: 500,
          fontFamily: SERIF,
          letterSpacing: "-0.01em",
        }}
      >
        Could not generate report
      </h1>
      <p style={{ color: MUTED, fontFamily: SANS, fontSize: 14 }}>
        Tried to load entity{" "}
        <code style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{entityId}</code> but ran into:
      </p>
      <pre
        style={{
          background: "#F5C9B6",
          color: "#7C2D12",
          padding: 14,
          borderRadius: 8,
          fontSize: 13,
          whiteSpace: "pre-wrap",
          border: "1px solid #7C2D12",
          fontFamily: "ui-monospace, Menlo, monospace",
        }}
      >
        {message}
      </pre>
    </main>
  );
}
