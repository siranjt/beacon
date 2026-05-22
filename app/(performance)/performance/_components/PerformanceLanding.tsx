"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useRecentReports, type RecentReport } from "./useRecentReports";
import ClientPreview from "./ClientPreview";
import ZocaLogo from "@/components/ZocaLogo";
import { BeaconMark } from "@/components/BeaconMark";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const SERIF = 'Georgia, "Times New Roman", "Times", serif';
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif";

const BRASS = "#D9A441";
const BRASS_DEEP = "#B8852E";
const EMBER = "#C8431D";
const TEXT = "#2B1F14";
const MUTED = "#6E5F50";
const FADED = "#8B7A66";
const BORDER = "#D4C29B";
const SURFACE = "#F8EFD7";

const MAX_VISIBLE = 4;

/**
 * Performance Beacon — landing page.
 *
 * Drops the hardcoded sample list. Recent reports are sourced from
 * localStorage (written when the user opens any /performance/report/[id]).
 * Clicking a recent card swaps the inline preview without navigation.
 */
export default function PerformanceLanding() {
  const router = useRouter();
  const recent = useRecentReports();
  const [entityId, setEntityId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Auto-select the most recent on first render after hydration.
  useEffect(() => {
    if (!selectedId && recent.length > 0) {
      setSelectedId(recent[0].entityId);
    }
  }, [recent, selectedId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = entityId.trim();
    if (!UUID_RE.test(id)) {
      setError("Please enter a valid UUID (e.g. a24bbd56-42ab-4540-9769-7cf65fadeaa6)");
      return;
    }
    setError(null);
    router.push(`/performance/report/${id}`);
  };

  const visible = recent.slice(0, MAX_VISIBLE);
  const selected = visible.find((r) => r.entityId === selectedId) ?? visible[0] ?? null;

  return (
    <BeaconPageShell>
      <>
      {/*
        Top bar replaced with the umbrella standard AgentHeader (Phase E-7
        visual unification — Customer Beacon's v1 register is the standard).
        Same sticky Parchment bar across all 4 agents + admin pill avatar +
        V2UserMenu sign-out. The previous Performance-specific header lived
        here inline; lift kept the agent-name suffix and live indicator,
        gained the umbrella's user menu chrome.
      */}
      <AgentHeader agentName="Performance" />

      {/* Hero */}
      <section style={{ padding: "44px 0 28px", textAlign: "center" }} className="pp-fade-in-up">
        <div
          style={{
            display: "inline-block",
            background: "#F5E6BB",
            border: `1px solid ${BRASS}`,
            padding: "4px 14px",
            borderRadius: 999,
            fontFamily: SANS,
            fontSize: 10,
            letterSpacing: "0.16em",
            color: BRASS_DEEP,
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          Report builder · V1
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "1.25rem",
            margin: "16px 0 0",
          }}
        >
          <span
            aria-hidden
            style={{
              fontSize: 28,
              color: "#2A4D5C",
              opacity: 0.6,
              userSelect: "none",
              flexShrink: 0,
            }}
          >
            ✦
          </span>
          <h1
            style={{
              margin: 0,
              fontFamily: SERIF,
              fontSize: "clamp(40px, 6vw, 64px)",
              fontWeight: 500,
              letterSpacing: "-0.02em",
              background: "linear-gradient(90deg, #2A4D5C 0%, #2B1F14 30%, #7C2D12 65%, #D9A441 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              lineHeight: 1,
            }}
          >
            Every entity, every signal
          </h1>
          <span
            aria-hidden
            style={{
              fontSize: 28,
              color: BRASS,
              opacity: 0.7,
              userSelect: "none",
              flexShrink: 0,
            }}
          >
            ✦
          </span>
        </div>
        <p
          style={{
            margin: "10px 0 0",
            fontFamily: SERIF,
            fontStyle: "italic",
            fontSize: 16,
            color: MUTED,
          }}
        >
          Per-entity growth &amp; local-SEO report
        </p>

        <form
          onSubmit={handleSubmit}
          style={{
            display: "flex",
            gap: 8,
            maxWidth: 600,
            margin: "26px auto 0",
            background: SURFACE,
            padding: 6,
            borderRadius: 12,
            border: `1px solid ${BORDER}`,
          }}
        >
          <input
            type="text"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            placeholder="a24bbd56-42ab-4540-9769-7cf65fadeaa6"
            style={{
              flex: 1,
              padding: "10px 14px",
              fontSize: 13,
              background: "transparent",
              border: "none",
              fontFamily: "ui-monospace, Menlo, monospace",
              color: TEXT,
              outline: "none",
            }}
          />
          <button
            type="submit"
            style={{
              padding: "10px 20px",
              background: BRASS,
              color: TEXT,
              border: `1px solid ${BRASS_DEEP}`,
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.02em",
              cursor: "pointer",
              fontFamily: SANS,
            }}
          >
            Generate report →
          </button>
        </form>
        {error && (
          <p
            style={{
              color: "#7C2D12",
              fontSize: 13,
              marginTop: 8,
              fontFamily: SANS,
            }}
          >
            {error}
          </p>
        )}
      </section>

      {/* Recent reports */}
      <RecentReportsRow
        items={visible}
        selectedId={selected?.entityId ?? null}
        onSelect={(id) => setSelectedId(id)}
      />

      {/* Preview header */}
      {selected && (
        <div style={{ padding: "8px 0 14px" }}>
          <div
            style={{
              fontFamily: SANS,
              fontSize: 10,
              letterSpacing: "0.14em",
              color: FADED,
              fontWeight: 600,
              textTransform: "uppercase",
            }}
          >
            Preview · {selected.bizname}
          </div>
        </div>
      )}

      {/* Preview slot (client-fetched) */}
      <ClientPreview entityId={selected?.entityId ?? null} />

      {/* Footer */}
      <footer
        style={{
          marginTop: 48,
          paddingTop: 18,
          borderTop: `1px solid ${BORDER}`,
          fontFamily: SANS,
          fontSize: 11,
          color: FADED,
          letterSpacing: "0.02em",
          lineHeight: 1.6,
        }}
      >
        Sources: Metabase Aurora (gbp.locations, gbp.metrics, local_seo.rank,
        entities.location_insights) and Postgres (website.booking_enquiries),
        accessed via the Metabase Dataset API.
      </footer>
      </>
    </BeaconPageShell>
  );
}

// ---------------------------------------------------------------------------
// Recent-reports row
// ---------------------------------------------------------------------------

function RecentReportsRow({
  items,
  selectedId,
  onSelect,
}: {
  items: RecentReport[];
  selectedId: string | null;
  onSelect: (entityId: string) => void;
}) {
  return (
    <section style={{ marginBottom: 22 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 10,
        }}
      >
        <div
          style={{
            fontFamily: SANS,
            fontSize: 10,
            letterSpacing: "0.14em",
            color: MUTED,
            fontWeight: 600,
            textTransform: "uppercase",
          }}
        >
          Recent reports
        </div>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 11,
            color: FADED,
          }}
        >
          Click to preview · double-click to open
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyRecent />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 10,
          }}
        >
          {items.map((r, idx) => (
            <RecentCard
              key={r.entityId}
              report={r}
              selected={r.entityId === selectedId}
              order={idx}
              onSelect={() => onSelect(r.entityId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RecentCard({
  report,
  selected,
  order,
  onSelect,
}: {
  report: RecentReport;
  selected: boolean;
  order: number;
  onSelect: () => void;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      className={`pp-card pp-fade-in-up ${selected ? "pp-card-selected" : ""}`}
      onClick={onSelect}
      onDoubleClick={() => router.push(`/performance/report/${report.entityId}`)}
      style={{
        background: SURFACE,
        border: `${selected ? "2" : "1"}px solid ${selected ? EMBER : BORDER}`,
        borderRadius: 10,
        padding: selected ? "11px 13px" : "12px 14px",
        textAlign: "left",
        cursor: "pointer",
        fontFamily: SERIF,
        color: "inherit",
        animationDelay: `${order * 70}ms`,
        display: "block",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 9,
            letterSpacing: "0.14em",
            color: selected ? EMBER : BRASS_DEEP,
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          {report.vertical || "Report"}
        </div>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 10,
            color: FADED,
          }}
        >
          {timeAgo(report.openedAt)}
        </div>
      </div>
      <div
        style={{
          fontFamily: SERIF,
          fontSize: 15,
          fontWeight: 600,
          marginTop: 4,
          color: TEXT,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={report.bizname}
      >
        {report.bizname}
      </div>
      <div
        style={{
          fontFamily: SANS,
          fontSize: 11,
          color: MUTED,
          marginTop: 2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {report.location || "—"}
      </div>
    </button>
  );
}

function EmptyRecent() {
  return (
    <div
      style={{
        background: SURFACE,
        border: `1px dashed ${BORDER}`,
        borderRadius: 10,
        padding: "20px 22px",
        fontFamily: SERIF,
        color: MUTED,
        fontSize: 14,
        textAlign: "center",
        lineHeight: 1.6,
      }}
    >
      <div style={{ fontStyle: "italic" }}>
        No reports yet. Paste an entity ID above to generate your first.
      </div>
      {/*
        Sample link is env-driven so we can swap or remove it without a code
        change. NEXT_PUBLIC_PERFORMANCE_SAMPLE_ENTITY_ID + _NAME control the
        suggestion. If either is empty, the sample row is omitted entirely
        (helps when the prior canonical entity gets renamed or churned).
        Previously this was a hardcoded entity UUID that would 404 if the
        underlying customer churned — a small footgun for new users.
      */}
      {process.env.NEXT_PUBLIC_PERFORMANCE_SAMPLE_ENTITY_ID && process.env.NEXT_PUBLIC_PERFORMANCE_SAMPLE_ENTITY_NAME && (
        <div style={{ fontFamily: SANS, fontSize: 12, color: FADED, marginTop: 6 }}>
          Try the sample:{" "}
          <Link
            href={`/performance/report/${process.env.NEXT_PUBLIC_PERFORMANCE_SAMPLE_ENTITY_ID}`}
            style={{ color: BRASS_DEEP, textDecoration: "none", fontWeight: 600 }}
          >
            {process.env.NEXT_PUBLIC_PERFORMANCE_SAMPLE_ENTITY_NAME} →
          </Link>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(ts: number): string {
  const diffSec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.floor(diffDay / 30);
  return `${diffMo}mo ago`;
}
