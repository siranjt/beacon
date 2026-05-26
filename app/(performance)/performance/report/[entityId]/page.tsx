import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchEntityReportData } from "@/lib/report/fetchers";
import { composeReport } from "@/lib/report/compose";
import BeaconPageShell from "@/components/BeaconPageShell";
import ReportPreview from "../../_components/ReportPreview";
import RecordRecentReport from "../../_components/RecordRecentReport";
import SuggestedActions from "@/components/ai/SuggestedActions";
// Phase E-18 — comms perspective chip in the report header. Cache-read
// only; we don't block the report render on Haiku. If today's row exists
// we paint the chip; otherwise the section stays empty and the on-demand
// /api endpoint fills the cache when an AM opens Customer 360.
import { readPerspective } from "@/lib/customer/comms-perspective-store";

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

  // Phase E-18 — cache-only perspective read. Don't await Haiku here.
  const perspective = await readPerspective(entityId).catch(() => null);

  return (
    <BeaconPageShell>
      <>
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
        {perspective && (
          <div
            style={{
              marginTop: 10,
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontFamily: SANS,
                fontSize: 10,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                padding: "3px 9px",
                borderRadius: 999,
                background:
                  perspective.sentiment === "warm"
                    ? "rgba(74,124,89,0.15)"
                    : perspective.sentiment === "neutral"
                      ? "rgba(110,95,80,0.10)"
                      : perspective.sentiment === "tense"
                        ? "rgba(200,67,29,0.15)"
                        : "rgba(124,45,18,0.20)",
                color:
                  perspective.sentiment === "warm"
                    ? "#4A7C59"
                    : perspective.sentiment === "neutral"
                      ? MUTED
                      : perspective.sentiment === "tense"
                        ? "#C8431D"
                        : "#7C2D12",
                fontWeight: 600,
              }}
            >
              {perspective.sentiment}
            </span>
            {perspective.topics.slice(0, 3).map((t) => (
              <span
                key={t}
                style={{
                  fontFamily: SANS,
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: "rgba(217,164,65,0.15)",
                  border: `1px solid ${BORDER}`,
                  color: TEXT,
                }}
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Phase E-9 — Beacon AI proactive recommendations for this report */}
      <SuggestedActions scope={{ kind: "performance-report", entityId }} />

      <ReportPreview report={report} />

      <RecordRecentReport
        entityId={entityId}
        bizname={i.title}
        vertical={i.verticalDisplay ?? "Report"}
        location={[i.city, i.state].filter(Boolean).join(", ")}
      />
      </>
    </BeaconPageShell>
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
