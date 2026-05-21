"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const SAMPLES = [
  {
    title: "Sheila Marie Aesthetics",
    vertical: "Facial spa",
    city: "San Mateo, CA",
    entityId: "a24bbd56-42ab-4540-9769-7cf65fadeaa6",
  },
];

/**
 * Client-side entity-id form. Submits to /performance/report/[entityId].
 * Styling stays close to the original Performance Report repo so the team's
 * muscle memory carries over — a Watchfire re-skin is a follow-up PR.
 */
export default function PerformanceLanding() {
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
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "64px 24px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#222",
      }}
    >
      <Link
        href="/"
        style={{ color: "#666", textDecoration: "none", fontSize: 13 }}
      >
        ← Back to Beacon
      </Link>
      <header style={{ marginBottom: 40, marginTop: 24 }}>
        <h1 style={{ margin: 0, fontSize: 30, fontWeight: 600 }}>
          Performance Beacon
        </h1>
        <p style={{ marginTop: 10, color: "#666", lineHeight: 1.6 }}>
          Generate a per-entity local-SEO &amp; growth report. Paste an{" "}
          <code>entity_id</code> below to view the report and download as Word.
        </p>
      </header>

      <form onSubmit={handleSubmit} style={{ marginBottom: 32 }}>
        <label
          htmlFor="eid"
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 500,
            marginBottom: 6,
          }}
        >
          Entity ID (UUID)
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="eid"
            type="text"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            placeholder="e.g. a24bbd56-42ab-4540-9769-7cf65fadeaa6"
            style={{
              flex: 1,
              padding: "10px 12px",
              fontSize: 14,
              border: "1px solid #ddd",
              borderRadius: 6,
              fontFamily: "ui-monospace, Menlo, monospace",
            }}
          />
          <button
            type="submit"
            style={{
              padding: "10px 18px",
              background: "#4472C4",
              color: "white",
              border: "none",
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Generate report →
          </button>
        </div>
        {error && (
          <p style={{ color: "#a31a1a", fontSize: 13, marginTop: 6 }}>
            {error}
          </p>
        )}
      </form>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, fontWeight: 500, color: "#666", margin: "0 0 8px" }}>
          Try a sample entity
        </h2>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {SAMPLES.map((s) => (
            <li
              key={s.entityId}
              style={{
                background: "#f4f7fc",
                border: "1px solid #e0e0e0",
                borderRadius: 6,
                padding: "10px 14px",
                marginBottom: 6,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>{s.title}</div>
                <div style={{ fontSize: 12, color: "#666" }}>
                  {s.vertical} · {s.city} ·{" "}
                  <code style={{ fontSize: 11 }}>{s.entityId}</code>
                </div>
              </div>
              <a
                href={`/performance/report/${s.entityId}`}
                style={{
                  fontSize: 13,
                  color: "#4472C4",
                  textDecoration: "none",
                  fontWeight: 500,
                }}
              >
                Open →
              </a>
            </li>
          ))}
        </ul>
      </section>

      <footer
        style={{
          marginTop: 56,
          paddingTop: 16,
          borderTop: "1px solid #eee",
          fontSize: 12,
          color: "#888",
        }}
      >
        Sources: Metabase Aurora (gbp.locations, gbp.metrics, local_seo.rank,
        entities.location_insights) and Postgres (website.booking_enquiries),
        accessed via the Metabase Dataset API.
      </footer>
    </main>
  );
}
