"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import RecentReports from "./RecentReports";

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

/**
 * Performance Beacon — landing page client shell.
 *
 * Layout (mockup-driven):
 *  1. Top bar with brand + live indicator
 *  2. Hero with eyebrow, title, search input + Generate button
 *  3. Recent reports grid (sample cards)
 *  4. Inline preview (server-rendered, streamed in via {children})
 */
export default function PerformanceLanding({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [entityId, setEntityId] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "0 22px 56px" }}>
      {/* Top bar */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 0",
          marginBottom: 8,
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <Link
          href="/"
          style={{
            fontFamily: SERIF,
            fontWeight: 600,
            fontSize: 17,
            letterSpacing: "0.04em",
            color: TEXT,
            textDecoration: "none",
          }}
        >
          B E A C O N
        </Link>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: SANS,
            fontSize: 11,
            letterSpacing: "0.12em",
            color: MUTED,
            textTransform: "uppercase",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: BRASS,
              boxShadow: `0 0 0 3px ${EMBER}22`,
            }}
            aria-hidden
          />
          Performance Beacon · Live
        </div>
      </header>

      {/* Hero */}
      <section style={{ padding: "44px 0 28px", textAlign: "center" }}>
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
        <h1
          style={{
            margin: "16px 0 0",
            fontFamily: SERIF,
            fontSize: "clamp(32px, 5vw, 48px)",
            fontWeight: 500,
            letterSpacing: "-0.015em",
            background: `linear-gradient(90deg, ${EMBER} 0%, ${BRASS} 100%)`,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            lineHeight: 1.1,
          }}
        >
          A signal worth following
        </h1>
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

        {/* Search */}
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

      {/* Recent reports grid */}
      <RecentReports />

      {/* Inline preview header */}
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
          Preview · Sheila Marie Aesthetics
        </div>
      </div>

      {/* Slot for the server-rendered preview (Suspense-streamed) */}
      {children}

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
    </main>
  );
}
